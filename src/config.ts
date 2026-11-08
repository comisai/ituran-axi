// Settings come from the environment only. Inside Comis, ITURAN_TOKEN holds the
// Gate's placeholder and nothing else is set. Outside, a username and password.

import { AxiError, usage } from './errors.ts';

export const DEFAULT_URL = 'https://api.ituran.com/api/v2';

export type Auth =
  | { kind: 'token'; token: string }
  | { kind: 'password'; user: string; password: string };

export interface Settings {
  /** The API root, such as https://api.ituran.com/api/v2. */
  url: string;
  origin: string;
  /** The API root's path, such as /api/v2. */
  basePath: string;
  /** The identity root on the same host: /api/vN becomes /api/v1. */
  identity: string;
  auth?: Auth;
  /** Epoch milliseconds from COMIS_DEADLINE, when set. */
  deadline?: number;
}

export function readSettings(env: NodeJS.ProcessEnv): Settings {
  const raw = (env.ITURAN_URL || env.ITURAN_GLOBAL_BASE_URL || DEFAULT_URL)
    .trim()
    .replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw usage('ITURAN_URL is not a URL. Use https://api.ituran.com/api/v2.');
  }
  const local = /^(localhost|127\.0\.0\.1)$/.test(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
    throw usage('ITURAN_URL must use https.');
  }
  const basePath = parsed.pathname.replace(/\/+$/, '');
  if (!/^\/api\/v\d+$/.test(basePath) || parsed.search || parsed.hash) {
    throw usage(
      'ITURAN_URL must be the API root, such as https://api.ituran.com/api/v2.',
    );
  }
  const settings: Settings = {
    url: `${parsed.origin}${basePath}`,
    origin: parsed.origin,
    basePath,
    identity: `${parsed.origin}${basePath.replace(/\/v\d+$/, '/v1')}`,
  };
  const token = env.ITURAN_TOKEN?.trim();
  if (token) settings.auth = { kind: 'token', token };
  else if (env.ITURAN_USERNAME && env.ITURAN_PASSWORD) {
    settings.auth = {
      kind: 'password',
      user: env.ITURAN_USERNAME,
      password: env.ITURAN_PASSWORD,
    };
  }
  const deadline = env.COMIS_DEADLINE;
  if (deadline !== undefined && deadline !== '') {
    const n = Number(deadline);
    if (!/^[1-9][0-9]*$/.test(deadline) || !Number.isSafeInteger(n)) {
      throw usage(
        'COMIS_DEADLINE must be a time in epoch milliseconds, a positive whole number.',
      );
    }
    settings.deadline = n;
  }
  return settings;
}

/** The settings, or not_connected when there is nothing to sign in with. */
export function connected(env: NodeJS.ProcessEnv): Settings & { auth: Auth } {
  const settings = readSettings(env);
  if (!settings.auth) {
    throw new AxiError(
      'not_connected',
      'Ituran is not connected. Inside Comis, ask the owner to run `comis connect ituran`. Elsewhere, set ITURAN_USERNAME and ITURAN_PASSWORD, or ITURAN_TOKEN.',
    );
  }
  return settings as Settings & { auth: Auth };
}
