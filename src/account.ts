// The account: who is signed in, the zone its times are in, and the services
// a read has found unavailable. Derived from Ituran and kept for a day in the
// cache directory; deleting it costs one users/me read.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Auth, Settings } from './config.ts';
import type { Client } from './http.ts';
import { zoneOf } from './time.ts';

const MAX_AGE_MS = 24 * 3600_000;

export interface Account {
  customer: string | null;
  user: string | null;
  role: string | null;
  /** users/me's own zone name, often a Windows id such as "Israel Standard Time". */
  zoneName: string | null;
  /** The IANA zone used for every time. */
  zone: string;
  /** Services a read found unavailable, with the error code it met. */
  unavailable: Record<string, string>;
  fetchedAt: string;
}

export function cacheDir(
  settings: Settings & { auth: Auth },
  env: NodeJS.ProcessEnv,
): string {
  const root = env.XDG_CACHE_HOME || join(env.HOME || homedir(), '.cache');
  const who =
    settings.auth.kind === 'password'
      ? `user:${settings.auth.user}`
      : `token:${createHash('sha256').update(settings.auth.token).digest('hex')}`;
  const key = createHash('sha256')
    .update(`${settings.url}|${who}`)
    .digest('hex')
    .slice(0, 16);
  return join(root, 'ituran-axi', key);
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Write atomically; a cache that cannot be written is only a slower next run. */
export function writeJson(dir: string, name: string, value: unknown): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, name);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    /* read-only or full disk: carry on without the cache */
  }
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v ? v : null;

export async function loadAccount(
  client: Client,
  dir: string,
  now: Date,
  fresh = false,
): Promise<Account> {
  const cached = readJson<Account>(join(dir, 'account.json'));
  if (
    !fresh &&
    cached &&
    now.getTime() - Date.parse(cached.fetchedAt) < MAX_AGE_MS &&
    now.getTime() >= Date.parse(cached.fetchedAt)
  ) {
    return cached;
  }
  const me = ((await client.read({
    method: 'GET',
    path: `${client.settings.basePath}/users/me`,
    ctx: { what: 'the signed-in user' },
  })) ?? {}) as Record<string, unknown>;
  const localization = (me.localization ?? {}) as Record<string, unknown>;
  const zoneName = str(localization.timezone_name);
  const account: Account = {
    customer: str(me.customer_name),
    user: str(me.user_name),
    role: str(me.role_name),
    zoneName,
    zone: zoneOf(zoneName ?? undefined),
    unavailable: cached?.unavailable ?? {},
    fetchedAt: now.toISOString(),
  };
  writeJson(dir, 'account.json', account);
  return account;
}

/** Remember that a service answered as unavailable, for the home view. */
export function noteUnavailable(
  dir: string,
  service: string,
  code: string,
): void {
  const cached = readJson<Account>(join(dir, 'account.json'));
  if (!cached || cached.unavailable[service] === code) return;
  cached.unavailable = { ...cached.unavailable, [service]: code };
  writeJson(dir, 'account.json', cached);
}

/** Forget a service's unavailability once a read of it succeeds. */
export function noteAvailable(dir: string, service: string): void {
  const cached = readJson<Account>(join(dir, 'account.json'));
  if (!cached || !(service in cached.unavailable)) return;
  const { [service]: _gone, ...rest } = cached.unavailable;
  cached.unavailable = rest;
  writeJson(dir, 'account.json', cached);
}
