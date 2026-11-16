// One invocation at a time per user's cache, across accounts and tokens.
// Keep Pace's gap at command boundaries too. An abandoned lock is never
// removed by age: a slow command may still own it.

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AxiError } from './errors.ts';
import { GAP_MS } from './pace.ts';

export const LOCK_WAIT_MS = 30_000;
const POLL_MS = 100;

export async function withCommandLock<T>(
  env: NodeJS.ProcessEnv,
  deadline: number | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const root = env.XDG_CACHE_HOME || join(env.HOME || homedir(), '.cache');
  const dir = join(root, 'ituran-axi');
  const lock = join(dir, 'command.lock');
  const next = join(dir, 'command.next');
  const waitMs = Math.min(
    LOCK_WAIT_MS,
    deadline === undefined ? LOCK_WAIT_MS : deadline - Date.now() - 1000,
  );
  const until = performance.now() + waitMs;
  if (waitMs <= 0) {
    throw new AxiError(
      'unreachable',
      'The time for this command ran out before Ituran was asked.',
    );
  }
  const unavailable = () =>
    new AxiError(
      'unreachable',
      `Another ituran-axi command is running, or left a lock at ${lock}. Wait for it to finish. If no command is running, remove that lock and try again.`,
    );
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    throw new AxiError(
      'unreachable',
      'Could not create the ituran-axi command lock. Check the cache directory permissions.',
    );
  }
  for (;;) {
    if (performance.now() >= until) throw unavailable();
    try {
      const fd = openSync(lock, 'wx', 0o600);
      try {
        writeFileSync(fd, `${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new AxiError(
          'unreachable',
          'Could not take the ituran-axi command lock. Check the cache directory permissions.',
        );
      }
      await sleep(Math.min(POLL_MS, Math.max(0, until - performance.now())));
    }
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    // Written under the lock, before the next process can enter. Even an
    // error or an interrupted command leaves a quiet gap before the next read.
    writeFileSync(next, String(Date.now() + GAP_MS), { mode: 0o600 });
    rmSync(lock);
  };
  const interrupt = () => process.exit(130);
  const terminate = () => process.exit(143);
  process.once('exit', release);
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try {
    let notBefore = 0;
    try {
      notBefore = Number(readFileSync(next, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // Bound a persisted time if the system clock moved backwards.
    const gap = Math.min(GAP_MS, notBefore - Date.now());
    if (gap > 0) {
      if (performance.now() + gap >= until) throw unavailable();
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
