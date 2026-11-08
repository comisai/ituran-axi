// Sign-in. With ITURAN_TOKEN (inside Comis, the Gate's placeholder) the token
// is sent as it is and the identity routes are never called. With a username
// and password, the token is kept in a private cache file and reused until
// near its end, then refreshed: Ituran's access protection blocks addresses
// that sign in again and again, and a command-line tool runs once per command.
// Identity answers carry tokens, so they are never quoted.

import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Auth, Settings } from './config.ts';
import { AxiError } from './errors.ts';
import { fetchAnswer, type HttpDeps, type Session, timeLeft } from './http.ts';
import { VERSION } from './version.ts';

/** A cached token is replaced this long before it ends. */
const RENEW_BEFORE_MS = 30 * 60_000;
const GRANT_TIMEOUT_MS = 30_000;
/** A lock older than this was left by a process that died. */
const STALE_LOCK_MS = 30_000;
const LOCK_POLL_MS = 250;
export const DEVICE_ID = 'ituran-axi';

interface Cached {
  access_token: string;
  refresh_token?: string;
  /** Epoch milliseconds. */
  expires_at: number;
}

export function tokenDir(
  settings: Settings,
  user: string,
  env: NodeJS.ProcessEnv,
): string {
  const state =
    env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state');
  const key = createHash('sha256')
    .update(`${settings.url}|${user}`)
    .digest('hex')
    .slice(0, 16);
  return join(state, 'ituran-axi', key);
}

/** expires_in counts minutes on Ituran (1440 = one day). A JWT's exp wins when present. */
export function expiresAt(
  token: string,
  expiresIn: unknown,
  nowMs: number,
): number {
  const parts = token.split('.');
  if (parts.length === 3) {
    try {
      const exp = JSON.parse(
        Buffer.from(parts[1] as string, 'base64url').toString('utf8'),
      ).exp;
      if (typeof exp === 'number') return exp * 1000;
    } catch {
      /* opaque after all */
    }
  }
  const minutes =
    typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : 60;
  return nowMs + minutes * 60_000;
}

class TokenSession implements Session {
  private readonly token: string;
  constructor(token: string) {
    this.token = token;
  }
  async header(): Promise<string> {
    return `Bearer ${this.token}`;
  }
  async renew(): Promise<boolean> {
    return false;
  }
}

class PasswordSession implements Session {
  private readonly dir: string;
  private readonly file: string;
  private readonly lock: string;
  private current: Cached | null = null;
  private renewed = false;
  private readonly settings: Settings;
  private readonly auth: Extract<Auth, { kind: 'password' }>;
  private readonly deps: HttpDeps;
  private readonly now: () => Date;

  constructor(
    settings: Settings,
    auth: Extract<Auth, { kind: 'password' }>,
    deps: HttpDeps,
    env: NodeJS.ProcessEnv,
    now: () => Date,
  ) {
    this.settings = settings;
    this.auth = auth;
    this.deps = deps;
    this.now = now;
    this.dir = tokenDir(settings, auth.user, env);
    this.file = join(this.dir, 'token.json');
    this.lock = join(this.dir, 'token.lock');
  }

  private fresh(t: Cached | null): boolean {
    return t !== null && t.expires_at - this.now().getTime() > RENEW_BEFORE_MS;
  }

  private readCache(): Cached | null {
    try {
      const t = JSON.parse(readFileSync(this.file, 'utf8')) as Cached;
      return typeof t.access_token === 'string' &&
        typeof t.expires_at === 'number'
        ? t
        : null;
    } catch {
      return null;
    }
  }

  private writeCache(t: Cached): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(t), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    for (;;) {
      try {
        closeSync(openSync(this.lock, 'wx', 0o600));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let old = false;
        try {
          old = Date.now() - statSync(this.lock).mtimeMs > STALE_LOCK_MS;
        } catch {
          continue;
        }
        if (old) {
          rmSync(this.lock, { force: true });
          continue;
        }
        if (timeLeft(this.settings, this.now) < LOCK_POLL_MS * 2) {
          throw new AxiError(
            'unreachable',
            'Another ituran-axi command is signing in. Run this one again in a moment.',
          );
        }
        await this.deps.sleep(LOCK_POLL_MS);
        // The other command may have finished signing in.
        const done = this.readCache();
        if (this.fresh(done)) return fn();
      }
    }
    try {
      return await fn();
    } finally {
      rmSync(this.lock, { force: true });
    }
  }

  private async grant(body: Record<string, string>): Promise<Cached> {
    const answer = await fetchAnswer(
      this.deps,
      new URL(`${this.settings.identity}/oauth/token`),
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': `ituran-axi/${VERSION}`,
        },
        body: JSON.stringify(body),
      },
      Math.min(GRANT_TIMEOUT_MS, timeLeft(this.settings, this.now)),
    );
    if (answer.status === 474) {
      throw new AxiError(
        'access_blocked',
        "Ituran's access protection blocked this computer's address. Do not retry; ask Ituran to review it.",
      );
    }
    if (answer.status === 400 || answer.status === 401) {
      throw new AxiError(
        'auth_failed',
        'Ituran refused the username or password. Check ITURAN_USERNAME and ITURAN_PASSWORD.',
      );
    }
    if (answer.status < 200 || answer.status >= 300) {
      throw new AxiError(
        'ituran_error',
        `Ituran's sign-in failed with ${answer.status}.`,
        { status: answer.status },
      );
    }
    const j = (answer.json ?? {}) as Record<string, unknown>;
    if (typeof j.access_token !== 'string' || !j.access_token) {
      throw new AxiError(
        'two_step_required',
        'Ituran asked for a second sign-in step, which no unattended tool can complete. Use a service account without two-step sign-in.',
      );
    }
    return {
      access_token: j.access_token,
      ...(typeof j.refresh_token === 'string'
        ? { refresh_token: j.refresh_token }
        : {}),
      expires_at: expiresAt(j.access_token, j.expires_in, this.now().getTime()),
    };
  }

  private passwordGrant(): Promise<Cached> {
    return this.grant({
      grant_type: 'password',
      username: this.auth.user,
      password: this.auth.password,
      device_id: DEVICE_ID,
      culture: 'en-US',
    });
  }

  async header(): Promise<string> {
    if (this.current && this.fresh(this.current))
      return `Bearer ${this.current.access_token}`;
    const cached = this.readCache();
    if (cached && this.fresh(cached)) {
      this.current = cached;
      return `Bearer ${cached.access_token}`;
    }
    this.current = await this.withLock(async (): Promise<Cached> => {
      const again = this.readCache();
      if (again && this.fresh(again)) return again;
      let next: Cached | null = null;
      if (again?.refresh_token) {
        try {
          next = await this.grant({
            grant_type: 'refresh_token',
            refresh_token: again.refresh_token,
          });
        } catch (error) {
          if (!(error instanceof AxiError && error.code === 'auth_failed'))
            throw error;
        }
      }
      next ??= await this.passwordGrant();
      this.writeCache(next);
      return next;
    });
    return `Bearer ${(this.current as Cached).access_token}`;
  }

  async renew(used: string): Promise<boolean> {
    if (this.renewed) return false;
    this.renewed = true;
    await this.withLock(async () => {
      const cached = this.readCache();
      if (!cached || `Bearer ${cached.access_token}` === used) {
        rmSync(this.file, { force: true });
        const next = await this.passwordGrant();
        this.writeCache(next);
        this.current = next;
      } else {
        this.current = cached;
      }
    });
    return true;
  }
}

export function sessionFor(
  settings: Settings & { auth: Auth },
  deps: HttpDeps,
  env: NodeJS.ProcessEnv,
  now: () => Date,
): Session {
  return settings.auth.kind === 'token'
    ? new TokenSession(settings.auth.token)
    : new PasswordSession(settings, settings.auth, deps, env, now);
}

/** Forget the cached token for these settings. Nothing is sent to Ituran. */
export function forgetToken(
  settings: Settings,
  user: string,
  env: NodeJS.ProcessEnv,
): boolean {
  const file = join(tokenDir(settings, user, env), 'token.json');
  let existed = false;
  try {
    statSync(file);
    existed = true;
  } catch {
    /* nothing cached */
  }
  rmSync(file, { force: true });
  return existed;
}
