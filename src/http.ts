// HTTP to Ituran, directly or through the Comis Gate (HTTPS_PROXY with
// NODE_USE_ENV_PROXY=1, set by the Comis wrapper). Reads and the closed list
// of place, alert and vehicle-group writes have separate entry points.
// Writes are sent once: no auth renewal, retry, or redirect replay.

import type { Auth, Settings } from './config.ts';
import {
  type Answer,
  AxiError,
  type ClassifyContext,
  classify,
  ituranCodes,
  ituranMessage,
} from './errors.ts';
import { parseJson } from './json.ts';
import { Pace } from './pace.ts';
import { VERSION } from './version.ts';

export const READ_TIMEOUT_MS = 60_000;
const RETRY_STATUSES = new Set([429, 481, 503]);
const MAX_RETRY_AFTER_MS = 15_000;
const DEFAULT_RETRY_MS = 2_000;

export interface HttpDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

export const defaultDeps: HttpDeps = {
  fetch: (...args) => fetch(...args),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Routes Ituran serves reads on with POST, below the API root. */
export const READ_POSTS: ReadonlySet<string> = new Set([
  '/vehicles/search',
  '/drivers/search',
  '/diagnostics',
  '/diagnostics/history',
  '/push-notifications/alerts/search',
  '/trips/totals',
  '/virtual-odometer',
  '/reports/bi/daily/drivers',
  '/reports/bi/daily/vehicles',
  '/reports/bi/idle_percentage/drivers',
  '/reports/bi/idle_percentage/vehicles',
  '/reports/bi/periodic/drivers',
  '/reports/bi/periodic/vehicles',
  '/safety/vehicles',
  '/safety/drivers',
  '/safety/totals',
  '/safety/periodic',
  '/safety/ubi/vehicles',
  '/safety/ubi/drivers',
  '/reports/events-report',
  '/reports/engine-and-switch-activity',
  '/reports/speed-report',
  '/reports/full-report',
  '/reports/diagnostics-report',
  '/reports/heat-map',
]);

export type Query = Record<
  string,
  string | number | readonly string[] | undefined
>;

export interface Read {
  method: 'GET' | 'POST';
  /** An absolute API path: the root's path (/api/v2/...) or another family (/api/v1/...). */
  path: string;
  query?: Query;
  body?: unknown;
  ctx?: ClassifyContext;
  /** A 404 means "none" on this route: return null instead of an error. */
  emptyOn404?: boolean;
}

export interface Session {
  /** The Authorization header value. */
  header(): Promise<string>;
  /** After a 401: true when a fresh token is worth exactly one more try. */
  renew(used: string): Promise<boolean>;
  /** Forget a refused cached token, without signing in or replaying a write. */
  invalidate?(used: string): Promise<void>;
}

export function isRead(
  settings: Settings,
  method: string,
  path: string,
): boolean {
  if (!path.startsWith('/api/') || /\.\.|%|\/\//.test(path)) return false;
  if (/^\/api\/v\d+\/oauth(\/|$)/.test(path)) return false;
  if (method === 'GET') return true;
  return (
    method === 'POST' &&
    path.startsWith(`${settings.basePath}/`) &&
    READ_POSTS.has(path.slice(settings.basePath.length))
  );
}

export function writeBody(body: unknown): string {
  return JSON.stringify(body).replace(
    /[\u007f-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export interface WriteAnswer {
  status: number;
  json: unknown;
}

const UNCERTAIN_WRITE =
  "The write may have been applied, or may be waiting for the owner's card. Do not repeat it. Check `comis action list`, or read `ituran-axi places`, `ituran-axi alerts` or `ituran-axi groups` first.";

export interface Write {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
}

/** Exactly the v2 record writes. No device, driver, contact or account route. */
export function isWrite(method: string, path: string): boolean {
  if (method === 'POST')
    return (
      /^\/api\/v2\/(places|alerts|vehicle-groups)$/.test(path) ||
      /^\/api\/v2\/vehicles\/[0-9A-Z]{1,12}\/alerts$/.test(path)
    );
  if (method === 'PUT' || method === 'DELETE')
    return (
      /^\/api\/v2\/(places|alerts|vehicle-groups)\/\d{1,20}$/.test(path) ||
      /^\/api\/v2\/vehicles\/[0-9A-Z]{1,12}\/alerts\/\d{1,20}$/.test(path) ||
      (method === 'PUT' && /^\/api\/v2\/alerts\/custom\/\d{1,20}$/.test(path))
    );
  return (
    method === 'PATCH' && /^\/api\/v2\/vehicle-groups\/\d{1,20}$/.test(path)
  );
}

function urlOf(settings: Settings, read: { path: string; query?: Query }): URL {
  const url = new URL(`${settings.origin}${read.path}`);
  for (const [key, value] of Object.entries(read.query ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value))
      for (const v of value) url.searchParams.append(key, v);
    else url.searchParams.set(key, String(value));
  }
  return url;
}

/** Milliseconds left before the command's deadline, less a one-second margin. */
export function timeLeft(settings: Settings, now: () => Date): number {
  return settings.deadline === undefined
    ? Number.POSITIVE_INFINITY
    : settings.deadline - now().getTime() - 1000;
}

export async function fetchAnswer(
  deps: HttpDeps,
  url: URL,
  init: { method: string; headers: Record<string, string>; body?: string },
  timeoutMs: number,
): Promise<Answer> {
  if (timeoutMs <= 0) {
    throw new AxiError(
      'unreachable',
      'The time for this command ran out before Ituran was asked.',
    );
  }
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response | undefined;
  let buffer: Buffer;
  try {
    response = await deps.fetch(url, {
      ...init,
      redirect: 'manual',
      signal: controller.signal,
    });
    buffer = Buffer.from(await response.arrayBuffer());
  } catch {
    throw new AxiError(
      'unreachable',
      controller.signal.aborted
        ? `Ituran did not answer within ${Math.round(timeoutMs / 1000)} s.`
        : 'Ituran could not be reached. Check the network, or whether the Gate is running.',
    );
  } finally {
    clearTimeout(timer);
    // Stop receiving even when buffering failed. The body may already be
    // consumed or cancelled by fetch; cancelling it again is harmless.
    controller.abort();
    if (response?.body) await response.body.cancel().catch(() => {});
  }
  const text = buffer.toString('utf8');
  let json: unknown;
  try {
    json = text ? parseJson(text) : undefined;
  } catch {
    json = undefined;
  }
  return {
    status: response.status,
    headers: response.headers,
    json,
    bytes: buffer.length,
    ms: Math.round(performance.now() - started),
  };
}

export class Client {
  readonly pace: Pace;
  readonly settings: Settings & { auth: Auth };
  private readonly session: Session;
  private readonly deps: HttpDeps;
  private readonly now: () => Date;

  constructor(
    settings: Settings & { auth: Auth },
    session: Session,
    deps: HttpDeps,
    now: () => Date,
  ) {
    this.settings = settings;
    this.session = session;
    this.deps = deps;
    this.now = now;
    this.pace = new Pace(deps.sleep);
  }

  private once(read: Read, header: string): Promise<Answer> {
    if (!isRead(this.settings, read.method, read.path)) {
      throw new AxiError(
        'internal_error',
        `ituran-axi refused to send ${read.method} ${read.path}: it is not a read.`,
      );
    }
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': `ituran-axi/${VERSION}`,
      Authorization: header,
    };
    if (read.body !== undefined) headers['Content-Type'] = 'application/json';
    return this.pace.run(() =>
      fetchAnswer(
        this.deps,
        urlOf(this.settings, read),
        {
          method: read.method,
          headers,
          ...(read.body !== undefined
            ? { body: JSON.stringify(read.body) }
            : {}),
        },
        Math.min(READ_TIMEOUT_MS, timeLeft(this.settings, this.now)),
      ),
    );
  }

  /** A confirmed record write. Never replay a request, even after 401 or 503. */
  async write(write: Write): Promise<WriteAnswer> {
    if (
      !isWrite(write.method, write.path) ||
      (write.method === 'DELETE'
        ? write.body !== undefined
        : write.body === undefined)
    ) {
      throw new AxiError(
        'internal_error',
        'ituran-axi refused an unsupported write request.',
      );
    }
    const header = await this.session.header();
    let answer: Answer;
    try {
      answer = await this.pace.run(() =>
        fetchAnswer(
          this.deps,
          urlOf(this.settings, write),
          {
            method: write.method,
            headers: {
              Accept: 'application/json',
              'User-Agent': `ituran-axi/${VERSION}`,
              Authorization: header,
              ...(write.body !== undefined
                ? { 'Content-Type': 'application/json' }
                : {}),
            },
            ...(write.body !== undefined
              ? { body: writeBody(write.body) }
              : {}),
          },
          Math.min(READ_TIMEOUT_MS, timeLeft(this.settings, this.now)),
        ),
      );
    } catch (error) {
      if (error instanceof AxiError && error.code === 'unreachable')
        throw new AxiError('unreachable', UNCERTAIN_WRITE, {
          detail: error.message,
        });
      throw error;
    }
    if (answer.status === 401 && !answer.headers.get('comis-refusal')) {
      try {
        await this.session.invalidate?.(header);
      } catch {
        /* preserve the refusal if cache cleanup fails */
      }
    }
    const codes = ituranCodes(answer.json);
    const said = ituranMessage(answer.json);
    // Only an ordinary record-not-found answer means the goal is reached.
    if (
      write.method === 'DELETE' &&
      answer.status === 404 &&
      !answer.headers.get('comis-refusal') &&
      codes.length > 0 &&
      codes.every((code) => code === '404')
    )
      return {
        status: 404,
        json: {
          result: true,
          already_absent: true,
          ...(said ? { ituran: said } : {}),
          ...(codes.length ? { codes: codes.join(' ') } : {}),
        },
      };
    const error = classify(answer, { what: 'record write' });
    if (error) {
      throw new AxiError(
        error.code,
        answer.status >= 500 && error.code !== 'held_for_approval'
          ? UNCERTAIN_WRITE
          : error.message,
        {
          ...error.fields,
          status: answer.status,
          ...(codes.length ? { codes: codes.join(' ') } : {}),
          ...(said ? { ituran: said } : {}),
        },
      );
    }
    return { status: answer.status, json: answer.json };
  }

  /** One read: its JSON, null for an empty 404 where allowed, or a classified error. */
  async read(read: Read): Promise<unknown> {
    let header = await this.session.header();
    let answer = await this.once(read, header);
    if (answer.status === 401 && !answer.headers.get('comis-refusal')) {
      if (await this.session.renew(header)) {
        header = await this.session.header();
        answer = await this.once(read, header);
      }
    }
    if (RETRY_STATUSES.has(answer.status)) {
      const after = Number(answer.headers.get('retry-after') ?? '') * 1000;
      const wait =
        Number.isFinite(after) && after > 0 && after <= MAX_RETRY_AFTER_MS
          ? after
          : DEFAULT_RETRY_MS;
      if (timeLeft(this.settings, this.now) > wait + 5_000) {
        await this.deps.sleep(wait);
        answer = await this.once(read, header);
      }
    }
    if (answer.status >= 300 && answer.status < 400) {
      throw new AxiError(
        'ituran_error',
        `Ituran answered with a redirect (${answer.status}), which ituran-axi does not follow.`,
      );
    }
    if (answer.status === 404 && read.emptyOn404) {
      const codes = ituranCodes(answer.json);
      if (!(read.ctx?.trips && codes.includes('404.1'))) return null;
    }
    const error = classify(answer, read.ctx);
    if (error) throw error;
    return answer.json;
  }
}
