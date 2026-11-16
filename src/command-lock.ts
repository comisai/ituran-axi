// One network command at a time per user's cache, across accounts and tokens.
// A heartbeat lease and owner token let killed processes recover without
// deleting or refreshing a replacement owner's lock.

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  futimesSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AxiError } from './errors.ts';
import { GAP_MS } from './pace.ts';

export const LOCK_WAIT_MS = 30_000;
const POLL_MS = 100;
const HEARTBEAT_MS = 2000;
const LEASE_MS = 10_000;

interface Owner {
  pid: number;
  hostname: string;
  token: string;
}

interface Snapshot {
  stat: Stats;
  owner: Owner | undefined;
}

function snapshot(file: string): Snapshot {
  const fd = openSync(file, 'r');
  try {
    const stat = fstatSync(fd);
    let owner: Owner | undefined;
    try {
      const value = JSON.parse(readFileSync(fd, 'utf8'));
      if (
        Number.isSafeInteger(value?.pid) &&
        value.pid > 0 &&
        typeof value.hostname === 'string' &&
        typeof value.token === 'string' &&
        value.token.length > 0
      )
        owner = value;
    } catch {
      // An interrupted creation or an old-format file still has a lease.
    }
    return { stat, owner };
  } finally {
    closeSync(fd);
  }
}

function stale(value: Snapshot): boolean {
  if (Date.now() - value.stat.mtimeMs > LEASE_MS) return true;
  if (value.owner?.hostname === hostname()) {
    try {
      process.kill(value.owner.pid, 0);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }
  return false;
}

/** Move out of the way, then re-check the inode, owner and heartbeat. */
function recover(lock: string): void {
  const before = snapshot(lock);
  if (!stale(before)) return;
  const moved = `${lock}.${randomUUID()}.stale`;
  renameSync(lock, moved);
  try {
    const after = snapshot(moved);
    if (
      before.stat.dev === after.stat.dev &&
      before.stat.ino === after.stat.ino &&
      before.owner?.token === after.owner?.token &&
      stale(after)
    )
      return;
    // A heartbeat or another contender changed the lock before the rename.
    // Restore without overwriting any owner that has since acquired the path.
    linkSync(moved, lock);
  } finally {
    rmSync(moved, { force: true });
  }
}

const busy = () =>
  new AxiError(
    'busy',
    'Another ituran-axi command is running. Wait for it to finish, then run this command again.',
  );

interface Held {
  fd: number;
  lock: string;
  next: string;
}

async function acquire(
  dir: string,
  until: number,
  owner: Owner,
): Promise<Held | null> {
  const lock = join(dir, 'command.lock');
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }
  for (;;) {
    if (performance.now() >= until) throw busy();
    let fd: number;
    try {
      fd = openSync(lock, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      try {
        recover(lock);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'EEXIST') return null;
      }
      await sleep(Math.min(POLL_MS, Math.max(0, until - performance.now())));
      continue;
    }
    try {
      writeFileSync(fd, JSON.stringify(owner));
      return { fd, lock, next: join(dir, 'command.next') };
    } catch {
      try {
        const current = snapshot(lock).stat;
        const created = fstatSync(fd);
        if (current.dev === created.dev && current.ino === created.ino)
          rmSync(lock, { force: true });
      } catch {
        /* cache failure */
      }
      try {
        closeSync(fd);
      } catch {
        /* cache failure */
      }
      return null;
    }
  }
}

export async function withCommandLock<T>(
  env: NodeJS.ProcessEnv,
  deadline: number | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const waitMs = Math.min(
    LOCK_WAIT_MS,
    deadline === undefined ? LOCK_WAIT_MS : deadline - Date.now() - 1000,
  );
  if (waitMs <= 0) {
    throw new AxiError(
      'unreachable',
      'The time for this command ran out before Ituran was asked.',
    );
  }
  const until = performance.now() + waitMs;
  const root = env.XDG_CACHE_HOME || join(env.HOME || homedir(), '.cache');
  const owner: Owner = {
    pid: process.pid,
    hostname: hostname(),
    token: randomUUID(),
  };
  const held =
    (await acquire(join(root, 'ituran-axi'), until, owner)) ??
    (await acquire(
      join(tmpdir(), `ituran-axi-${process.getuid?.() ?? 'user'}`),
      until,
      owner,
    ));
  // Cache storage is an optimization. Preserve reads even if both locations
  // are unavailable; contention on a usable lock never takes this fallback.
  if (!held) return fn();

  const ownsPath = () => {
    try {
      return snapshot(held.lock).owner?.token === owner.token;
    } catch {
      return false;
    }
  };
  const heartbeat = setInterval(() => {
    try {
      const now = new Date();
      // Refresh this inode, even if the pathname now belongs to someone else.
      futimesSync(held.fd, now, now);
    } catch {
      /* a failed refresh expires the lease */
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    try {
      if (ownsPath()) {
        try {
          writeFileSync(held.next, String(Date.now() + GAP_MS), {
            mode: 0o600,
          });
        } catch {
          /* a cache failure must not replace the command result */
        } finally {
          if (ownsPath()) rmSync(held.lock, { force: true });
        }
      }
    } catch {
      /* cleanup must not replace the command result */
    } finally {
      try {
        closeSync(held.fd);
      } catch {
        /* already closed */
      }
    }
  };
  const interrupt = () => process.exit(130);
  const terminate = () => process.exit(143);
  process.once('exit', release);
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try {
    let notBefore = 0;
    try {
      notBefore = Number(readFileSync(held.next, 'utf8'));
    } catch {
      /* an unavailable gap cache does not block reads */
    }
    const gap = Math.min(GAP_MS, notBefore - Date.now());
    if (gap > 0) {
      if (performance.now() + gap >= until) throw busy();
      await sleep(gap);
    }
    return await fn();
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    process.removeListener('exit', release);
    release();
  }
}
