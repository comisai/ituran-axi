#!/usr/bin/env node

// ituran-live: live qualification of the Ituran API for ituran-axi.
//
// Read-only by construction. The one HTTP helper sends GET, POST only to the
// read routes Ituran serves as POST (searches and reports), and the identity
// token grant. Any other request is refused before it leaves this process.
// No dependencies. Node 22 or later. Never prints or stores the password or a
// token. The report holds no plates, names, coordinates or addresses: it keeps
// statuses, timings, counts, field names and value shapes.
//
// Settings (environment):
//   ITURAN_URL                the API root, such as https://api.ituran.com/api/v2
//                             (ITURAN_GLOBAL_BASE_URL, ituran-mcp's name, also works)
//   ITURAN_IDENTITY_BASE_URL  optional; derived from the API root (/api/vN -> /api/v1)
//   ITURAN_USERNAME           a service account without two-step sign-in
//   ITURAN_PASSWORD
//   ITURAN_TOKEN              optional bearer token (inside Comis: the Gate's
//                             placeholder); when set, no password grant is sent
//
// Exit: 0 no failures (blocked stages allowed unless --strict), 1 failures, 2 usage.

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AREAS, useCases } from './use-cases.mjs';

const VERSION = '0.1.0';
// The ituran-mcp release the parity stage compares against.
const MCP_VERSION = '4.2.0';
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
// Starts at least this far apart, one request at a time: well under the
// upstream pressure guard (HTTP 481) that answers bursts.
const GAP_MS = 400;
// A username that cannot exist, so failure probes never count against the real account.
const BOGUS_USER = 'ituran-live-no-such-user';
const BOGUS_PLATE = '0000000';
const DEVICE_ID = 'ituran-axi-live';

// Reads that Ituran serves as POST, relative to the API root. Nothing else may be POSTed.
const READ_POSTS = new Set([
  '/vehicles/search',
  '/vehicles/location',
  '/contacts/search',
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

// Windows zone ids users/me may return, mapped to IANA.
const WINDOWS_ZONES = {
  'Israel Standard Time': 'Asia/Jerusalem',
  UTC: 'UTC',
  'GMT Standard Time': 'Europe/London',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'Russian Standard Time': 'Europe/Moscow',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Pacific Standard Time': 'America/Los_Angeles',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'Argentina Standard Time': 'America/Buenos_Aires',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'Mid-Atlantic Standard Time': 'Etc/GMT+2',
};

const USAGE = `usage: ituran-live [--strict] [--deep] [--parity] [--no-refresh] [--axi <path>|none]
                   [--gate-entry <path>] [--report <path>]
Live checks of the Ituran API, read-only. Settings come from ITURAN_GLOBAL_BASE_URL,
ITURAN_USERNAME and ITURAN_PASSWORD, or ITURAN_TOKEN.
  --strict      count blocked stages as failures (a milestone gate)
  --deep        S9b: more reads per vehicle: trip points and safety, a heat map, an
                operational report, diagnostics history, event drill-down
  --parity      S12: run ituran-mcp@${MCP_VERSION} read-only and compare its answers
                (it signs in once more)
  --use-cases   S14: answer the 126 questions of ituran-mcp's USER-PROMPTS.md with the
                built ituran-axi (about 150 commands; read-only)
  --form-grant  sign in and refresh form-encoded, as the Comis Gate's exchange does
  --no-refresh  skip the refresh-token grant in S4
  --axi         ituran-axi entry for S11 (default dist/bin/ituran-axi.js when built); none skips
  --gate-entry  draft Comis Gate entry for S13 (default comis/key-services/ituran.json)
  --report      JSON report path (default test/live/reports/<time>.json)
exit: 0 no failures, 1 failures (or blocked with --strict), 2 usage`;

// ---------- output helpers (TOON) ----------

function cell(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  if (
    s === '' ||
    /[,:"\\\n\r\t[\]{}]|^\s|\s$|^-/.test(s) ||
    /^(true|false|null|-?\d+(\.\d+)?([eE][+-]?\d+)?)$/.test(s)
  ) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
  }
  return s;
}

function usageError(message) {
  console.log(`error: usage\nmessage: ${cell(message)}\n${USAGE}`);
  process.exit(2);
}

// ---------- arguments and settings ----------

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
      strict: { type: 'boolean' },
      deep: { type: 'boolean' },
      parity: { type: 'boolean' },
      'use-cases': { type: 'boolean' },
      'form-grant': { type: 'boolean' },
      'no-refresh': { type: 'boolean' },
      axi: { type: 'string' },
      'gate-entry': { type: 'string' },
      report: { type: 'string' },
    },
  }));
} catch (e) {
  usageError(e.message);
}
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
if (args.version) {
  console.log(VERSION);
  process.exit(0);
}

function readConfig(env) {
  const base = (env.ITURAN_URL || env.ITURAN_GLOBAL_BASE_URL || '')
    .trim()
    .replace(/\/+$/, '');
  let origin = '';
  let basePath = '';
  try {
    const u = new URL(base);
    origin = u.origin;
    basePath = u.pathname.replace(/\/+$/, '');
  } catch {
    /* reported by S1 */
  }
  const identity = (
    env.ITURAN_IDENTITY_BASE_URL || base.replace(/\/v\d+$/, '/v1')
  )
    .trim()
    .replace(/\/+$/, '');
  return {
    base,
    origin,
    basePath,
    identity,
    user: env.ITURAN_USERNAME || '',
    password: env.ITURAN_PASSWORD || '',
    token: env.ITURAN_TOKEN || '',
  };
}

const cfg = readConfig(process.env);

// ---------- run state ----------

const ctx = {
  abort: null,
  token: cfg.token || null,
  secrets: new Set([cfg.password, cfg.token].filter((s) => s && s.length >= 4)),
  plates: new Set(),
  sample: [],
  tz: 'UTC',
  requests: [],
  dateFields: {},
  bigInts: 0,
  hebrewStrings: 0,
  bidiControls: 0,
  shapes: {},
  probes: {},
  firstTrip: null,
  firstPlace: null,
  firstEvent: null,
};

function remember(secret) {
  if (typeof secret === 'string' && secret.length >= 4) ctx.secrets.add(secret);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scrub(text) {
  let s = String(text);
  for (const secret of ctx.secrets) s = s.split(secret).join('[redacted]');
  for (const plate of ctx.plates) {
    s = s.replace(
      new RegExp(`(?<![0-9A-Za-z])${escapeRegex(plate)}(?![0-9A-Za-z])`, 'g'),
      '[plate]',
    );
  }
  return s;
}

// ---------- HTTP ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastStart = 0;
async function pace() {
  const wait = lastStart + GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastStart = Date.now();
}

const tokenUrl = () => `${cfg.identity}/oauth/token`;
const api = (p) => `${cfg.basePath}${p}`;

function isRead(method, path) {
  if (method === 'GET')
    return !path.startsWith(`${new URL(cfg.identity).pathname}/oauth`);
  if (method === 'POST')
    return (
      path.startsWith(`${cfg.basePath}/`) &&
      READ_POSTS.has(path.slice(cfg.basePath.length))
    );
  return false;
}

// One request. path is an absolute API path (/api/v2/...) or the token URL.
async function call(method, path, o = {}) {
  const isGrant = path === tokenUrl();
  if (!isGrant && !isRead(method, path))
    throw new Error(`refused locally: ${method} ${path} is not a read`);
  const url = new URL(isGrant ? path : `${cfg.origin}${path}`);
  for (const [k, v] of Object.entries(o.query || {})) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v))
      for (const item of v) url.searchParams.append(k, String(item));
    else url.searchParams.set(k, String(v));
  }
  const headers = {
    Accept: 'application/json',
    'User-Agent': `ituran-live/${VERSION}`,
  };
  const bearer = o.token === undefined ? ctx.token : o.token;
  if (!isGrant && o.auth !== false && bearer)
    headers.Authorization = `Bearer ${bearer}`;
  let body;
  if (o.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(o.form).toString();
  } else if (o.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(o.body);
  }
  await pace();
  const t0 = performance.now();
  const rec = {
    method,
    path: url.pathname,
    grant: isGrant,
    status: 0,
    ms: 0,
    bytes: 0,
  };
  ctx.requests.push(rec);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(o.timeout || 60_000),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    Object.assign(rec, {
      status: res.status,
      ms: Math.round(performance.now() - t0),
      bytes: buf.length,
      encoding: res.headers.get('content-encoding') || '',
      headerNames: [...res.headers.keys()],
    });
    if (!isGrant) observe(text, json);
    return { ...rec, headers: res.headers, text, json };
  } catch (e) {
    const error =
      e.name === 'TimeoutError'
        ? 'timeout'
        : String(e.cause?.code || e.cause?.message || e.message);
    Object.assign(rec, { ms: Math.round(performance.now() - t0), error });
    return { ...rec, headers: new Headers(), text: '', json: undefined, error };
  }
}

const get = (p, query, o = {}) => call('GET', api(p), { ...o, query });
const getAbs = (p, query, o = {}) => call('GET', p, { ...o, query });
const post = (p, body, query, o = {}) =>
  call('POST', api(p), { ...o, body, query });

// --form-grant sends the account's grants form-encoded, the way the Comis
// Gate's password exchange sends them; JSON otherwise, as ituran-mcp does.
function grant(body) {
  return args['form-grant']
    ? call('POST', tokenUrl(), { form: body, timeout: 30_000 })
    : call('POST', tokenUrl(), { body, timeout: 30_000 });
}

// ---------- reading responses (shapes only) ----------

const DATE_CLASSES = [
  ['date_only', /^\d{4}-\d{2}-\d{2}$/],
  ['naive', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/],
  ['utc', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/],
  ['offset', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:\d{2}$/],
  ['iso_duration', /^-?P(\d+D)?(T(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/],
  ['clock', /^\d{1,4}:\d{2}:\d{2}$/],
];
const HEBREW = /[֐-׿]/;
const BIDI = /[​-‏‪-‮⁦-⁩﻿]/;

function walk(v, fn, key = '') {
  if (Array.isArray(v)) {
    for (const item of v.slice(0, 50)) walk(item, fn, key);
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) walk(x, fn, k);
  } else {
    fn(key, v);
  }
}

function observe(text, json) {
  const big = text.match(/[:[,]\s*-?\d{16,}(?=\s*[,}\]])/g);
  if (big) ctx.bigInts += big.length;
  if (json === undefined) return;
  walk(json, (key, v) => {
    if (typeof v !== 'string') return;
    if (HEBREW.test(v)) ctx.hebrewStrings++;
    if (BIDI.test(v)) ctx.bidiControls++;
    for (const [cls, re] of DATE_CLASSES) {
      if (re.test(v)) {
        if (!ctx.dateFields[cls]) ctx.dateFields[cls] = new Set();
        const keys = ctx.dateFields[cls];
        if (keys.size < 12 && key) keys.add(key);
        break;
      }
    }
  });
}

// A compact shape: keys and value types, arrays as [n], never values.
function shape(v, depth = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v))
    return v.length ? { [`[${v.length}]`]: shape(v[0], depth + 1) } : '[0]';
  if (v && typeof v === 'object') {
    if (depth >= 4) return '{…}';
    const out = {};
    for (const k of Object.keys(v).slice(0, 40))
      out[k] = shape(v[k], depth + 1);
    return out;
  }
  return typeof v;
}

function rowsOf(json, key) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return null;
  if (key && Array.isArray(json[key])) return json[key];
  for (const v of Object.values(json)) if (Array.isArray(v)) return v;
  return null;
}

function paginationOf(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  if (json.metadata?.pagination)
    return { path: 'metadata.pagination', block: json.metadata.pagination };
  if (json.meta?.pagination)
    return { path: 'meta.pagination', block: json.meta.pagination };
  if (json.pagination) return { path: 'pagination', block: json.pagination };
  if (json.metadata && typeof json.metadata.total_count === 'number')
    return { path: 'metadata', block: json.metadata };
  return null;
}

function codesOf(json) {
  const out = [];
  if (!json || typeof json !== 'object') return out;
  for (const k of ['error_code', 'errorCode', 'code'])
    if (json[k] !== undefined && json[k] !== null) out.push(String(json[k]));
  if (Array.isArray(json.errors)) {
    for (const e of json.errors) {
      const c = e?.error_code ?? e?.code;
      if (c !== undefined && c !== null) out.push(String(c));
    }
  }
  return out;
}

function messageOf(json) {
  if (!json || typeof json !== 'object') return undefined;
  const top =
    json.error_description ??
    json.errorDescription ??
    json.message ??
    json.error;
  let nested;
  if (Array.isArray(json.errors)) {
    nested = json.errors
      .map((e) =>
        [
          e?.error_code ?? e?.code,
          e?.error_description ?? e?.description ?? e?.message,
        ]
          .filter(Boolean)
          .join(': '),
      )
      .join('; ');
  } else if (json.errors && typeof json.errors === 'object') {
    nested = Object.entries(json.errors)
      .map(([f, m]) => `${f}: ${Array.isArray(m) ? m.join(', ') : m}`)
      .join('; ');
  }
  const s = [top, nested].filter((x) => x && typeof x === 'string').join(' | ');
  return s ? s.slice(0, 200) : undefined;
}

function outcome(r) {
  if (r.status === 0) return 'unreachable';
  if (r.status >= 200 && r.status < 300) return 'available';
  const codes = codesOf(r.json);
  if (r.status === 474) return 'access_denied';
  if (r.status === 481) return 'pressure_guard';
  if (r.status === 429) return 'rate_limited';
  if (r.status === 401) return 'auth_rejected';
  if (codes.includes('1032')) return 'needs_app_id';
  if (r.status === 403) {
    if (codes.includes('403.2')) return 'feature_gated';
    if (codes.includes('1020')) return 'not_visible';
    return 'not_entitled';
  }
  if (r.status === 404) return 'not_found_or_empty';
  if (r.status === 400) return 'request_rejected';
  if (r.status >= 500) return 'upstream_error';
  return `status_${r.status}`;
}

function zoneOf(name) {
  const candidate = WINDOWS_ZONES[name] || name;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: candidate });
    return candidate;
  } catch {
    return null;
  }
}

// Account-local calendar date, offsetDays from today.
function localDate(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ctx.tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

// Account-local wall clock, minutes from now, as a naive ISO string.
function localNow(offsetMinutes = 0) {
  const d = new Date(Date.now() + offsetMinutes * 60_000);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: ctx.tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

const enc = (s) => encodeURIComponent(s);

// ---------- stage runner ----------

const results = [];

function checks() {
  const list = [];
  const c = (name, ok, got) => {
    list.push({
      name,
      ok: Boolean(ok),
      ...(got !== undefined ? { got: scrub(got) } : {}),
    });
    return Boolean(ok);
  };
  c.list = list;
  c.result = (detail, facts = {}) => {
    const failed = list.filter((x) => !x.ok);
    return {
      status: failed.length ? 'fail' : 'pass',
      detail: failed.length
        ? `failed: ${failed.map((x) => x.name).join('; ')}`
        : detail,
      checks: list,
      facts,
    };
  };
  return c;
}

async function stage(id, name, fn, { always = false } = {}) {
  if (ctx.abort && !always) {
    results.push({
      id,
      name,
      status: 'skip',
      detail: `skipped: ${ctx.abort}`,
      ms: 0,
      checks: [],
      facts: {},
    });
    return;
  }
  const t0 = performance.now();
  let r;
  try {
    r = await fn();
  } catch (e) {
    r = { status: 'fail', detail: `crashed: ${e.message}` };
  }
  results.push({
    id,
    name,
    status: r.status,
    detail: scrub(r.detail ?? ''),
    ms: Math.round(performance.now() - t0),
    checks: r.checks || [],
    facts: r.facts || {},
  });
}

// ---------- stages ----------

const startedAt = new Date();
const env = /(^|\.)api\.ituran\.com$/.test(
  new URL(cfg.origin || 'http://x').hostname,
)
  ? 'production'
  : /api-qa\./.test(cfg.origin)
    ? 'qa'
    : /testapi\./.test(cfg.origin)
      ? 'test'
      : 'other';

await stage('S1', 'config', async () => {
  const c = checks();
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(cfg.origin);
  c(
    'ITURAN_URL or ITURAN_GLOBAL_BASE_URL set',
    Boolean(cfg.base),
    cfg.base || '(empty)',
  );
  c(
    'https, or http on localhost',
    local || cfg.origin.startsWith('https://'),
    cfg.origin || '(empty)',
  );
  c(
    'API root ends in /api/vN',
    /\/api\/v\d+$/.test(cfg.basePath),
    cfg.basePath || '(empty)',
  );
  c(
    'a token, or a username and password',
    Boolean(cfg.token || (cfg.user && cfg.password)),
    cfg.token ? 'token' : 'none',
  );
  c(
    'identity root derived',
    /^https?:\/\/[^/]+\/api\/v\d+$/.test(cfg.identity),
    cfg.identity,
  );
  const r = c.result(
    `${cfg.base} · ${env} · ${cfg.token ? 'token' : `user ${cfg.user}`}`,
    {
      environment: env,
      sign_in: cfg.token ? 'token' : 'password_grant',
      identity_root: cfg.identity,
    },
  );
  if (r.status === 'fail') ctx.abort = 'settings incomplete';
  return r;
});

await stage('S2', 'reach', async () => {
  const r = await get('/users/me', undefined, { auth: false });
  if (r.status === 0) {
    ctx.abort = 'endpoint unreachable';
    const tls = /CERT|SSL|TLS|ISSUER/i.test(r.error || '');
    return {
      status: 'fail',
      detail: `unreachable: ${r.error}${tls ? ' (set NODE_EXTRA_CA_CERTS to the system CA bundle)' : ''}`,
    };
  }
  if (r.status === 474) {
    ctx.abort =
      'blocked by the access protection in front of Ituran (HTTP 474)';
    return {
      status: 'fail',
      detail: '474: this IP is blocked; ask Ituran to review it',
    };
  }
  const c = checks();
  c(
    'unauthenticated read refused (400 or 401)',
    r.status === 400 || r.status === 401,
    r.status,
  );
  c(
    'refusal carries no account data',
    !rowsOf(r.json) && !r.json?.user_id,
    r.json ? Object.keys(r.json).join(' ') : r.bytes,
  );
  return c.result(`${r.status} in ${r.ms} ms`, {
    reach_ms: r.ms,
    unauth_status: r.status,
    unauth_www_authenticate: r.headers.get('www-authenticate') || null,
    unauth_body_bytes: r.bytes,
    unauth_body_shape:
      r.json === undefined ? 'empty or not JSON' : shape(r.json),
    unauth_codes: codesOf(r.json),
    unauth_message: messageOf(r.json) ?? null,
    server_header: r.headers.get('server') || null,
  });
});

await stage('S3', 'sign in', async () => {
  if (cfg.token)
    return {
      status: 'skip',
      detail: 'ITURAN_TOKEN set: no password grant sent',
    };
  const c = checks();
  const r = await grant({
    grant_type: 'password',
    username: cfg.user,
    password: cfg.password,
    device_id: args['form-grant'] ? 'comis-gate' : DEVICE_ID,
    culture: 'en-US',
  });
  const j = r.json || {};
  remember(j.access_token);
  remember(j.refresh_token);
  if (r.status === 474) {
    ctx.abort = 'identity blocked (HTTP 474)';
    return {
      status: 'fail',
      detail: '474 on the identity route: ask Ituran to review this IP',
    };
  }
  if (r.status === 400 || r.status === 401) {
    ctx.abort = 'credentials rejected';
    return {
      status: 'fail',
      detail: `${r.status}: the identity service rejected the username or password`,
      facts: { grant_status: r.status, grant_error: j.error ?? null },
    };
  }
  c('password grant 200', r.status === 200, r.status);
  c(
    'access_token present (no one-time-code challenge)',
    typeof j.access_token === 'string' && j.access_token.length > 0,
    Object.keys(j).join(' '),
  );
  c('refresh_token present', typeof j.refresh_token === 'string');
  if (!j.access_token) {
    ctx.abort = 'no access token';
    return c.result('');
  }
  ctx.token = j.access_token;
  ctx.refresh = j.refresh_token;
  const jwt = j.access_token.split('.').length === 3;

  // A grant for a user that cannot exist: the rejection shape, with no lockout risk.
  const bogus = await grant({
    grant_type: 'password',
    username: BOGUS_USER,
    password: `x-${Date.now()}`,
    device_id: DEVICE_ID,
    culture: 'en-US',
  });
  c(
    'unknown user rejected with 400 or 401',
    bogus.status === 400 || bogus.status === 401,
    bogus.status,
  );
  c('rejection carries no token', !/access_token/.test(bogus.text || ''));
  // The same rejection sent form-encoded: does the token route parse form bodies?
  const form = await call('POST', tokenUrl(), {
    form: {
      grant_type: 'password',
      username: BOGUS_USER,
      password: `x-${Date.now()}`,
    },
    timeout: 30_000,
  });
  const formParsed =
    form.status === bogus.status &&
    (form.json?.error ?? null) === (bogus.json?.error ?? null) &&
    (messageOf(form.json) ?? null) === (messageOf(bogus.json) ?? null);

  return c.result(`token in ${r.ms} ms, expires_in ${j.expires_in}`, {
    grant_encoding: args['form-grant'] ? 'form' : 'json',
    grant_ms: r.ms,
    grant_keys: Object.keys(j),
    token_type: j.token_type ?? null,
    token_kind: jwt ? 'jwt' : 'opaque',
    token_length: j.access_token.length,
    expires_in: j.expires_in ?? null,
    expires_in_hours_if_minutes:
      typeof j.expires_in === 'number' ? j.expires_in / 60 : null,
    bogus_grant_status: bogus.status,
    bogus_grant_body: bogus.json
      ? {
          keys: Object.keys(bogus.json),
          error: bogus.json.error ?? null,
          error_description: messageOf(bogus.json) ?? null,
        }
      : `${bogus.bytes} bytes, not JSON`,
    form_grant_status: form.status,
    form_grant_error: form.json?.error ?? null,
    form_grant_description: messageOf(form.json) ?? null,
    form_body_parsed_like_json: formParsed,
  });
});

await stage('S4', 'token', async () => {
  const c = checks();
  const me = await get('/users/me');
  c('token reads users/me', me.status === 200, me.status);
  const fake = 'A'.repeat(88);
  const bad = await get('/users/me', undefined, { token: fake });
  c('a made-up token gets 401', bad.status === 401, bad.status);
  const facts = {
    bad_token_status: bad.status,
    bad_token_www_authenticate: bad.headers.get('www-authenticate') || null,
    bad_token_body: bad.json ? shape(bad.json) : `${bad.bytes} bytes`,
  };
  if (cfg.token || args['no-refresh'] || !ctx.refresh) {
    return c.result(
      cfg.token
        ? 'token works (refresh not tested: token mode)'
        : 'token works (refresh skipped)',
      facts,
    );
  }
  const old = ctx.token;
  const oldRefresh = ctx.refresh;
  const r = await grant({
    grant_type: 'refresh_token',
    refresh_token: ctx.refresh,
  });
  const j = r.json || {};
  remember(j.access_token);
  remember(j.refresh_token);
  c('refresh grant 200', r.status === 200, r.status);
  if (r.status !== 200 || !j.access_token)
    return c.result('', {
      ...facts,
      refresh_status: r.status,
      refresh_error: j.error ?? null,
    });
  const fresh = await get('/users/me', undefined, { token: j.access_token });
  c('refreshed token reads users/me', fresh.status === 200, fresh.status);
  const oldAfter = await get('/users/me', undefined, { token: old });
  ctx.token = j.access_token;
  ctx.refresh = j.refresh_token || ctx.refresh;
  return c.result('token works; refresh works', {
    ...facts,
    refresh_ms: r.ms,
    refresh_new_access_token: j.access_token !== old,
    refresh_rotates_refresh_token:
      typeof j.refresh_token === 'string' && j.refresh_token !== oldRefresh,
    refresh_expires_in: j.expires_in ?? null,
    old_token_after_refresh_status: oldAfter.status,
  });
});

await stage('S5', 'account', async () => {
  const c = checks();
  const r = await get('/users/me');
  c('users/me 200', r.status === 200, r.status);
  const j = r.json || {};
  const zoneName = j.localization?.timezone_name ?? null;
  const zone = zoneName ? zoneOf(zoneName) : null;
  if (zone) ctx.tz = zone;
  c('account time zone known', Boolean(zone), zoneName ?? '(none)');
  let perms = 0;
  let profile = 0;
  const names = new Set();
  // Counted directly: walk() samples only the first 50 items of an array.
  for (const v of Array.isArray(j.permissions) ? j.permissions : []) {
    if (typeof v !== 'string') continue;
    perms++;
    if (/^Profile Method\s*:/i.test(v)) profile++;
    else if (names.size < 80) names.add(v);
  }
  const echoes = [...ctx.secrets].some((s) => (r.text || '').includes(s));
  c('answer carries no token or password', !echoes);
  ctx.shapes.users_me = shape(j);
  return c.result(`zone ${zoneName ?? 'unknown'} -> ${ctx.tz}`, {
    account_timezone: zoneName,
    account_zone_iana: ctx.tz,
    account_culture:
      j.localization?.culture ?? j.localization?.language ?? null,
    users_me_keys: Object.keys(j),
    permission_strings: perms,
    profile_method_strings: profile,
    // The web interface's capability names, such as CanRunReports; not personal data.
    permission_names: [...names],
    permissions_shape: shape(j.permissions),
  });
});

await stage('S6', 'entitlements', async () => {
  const y = localDate(-1);
  const from = `${y}T00:00:00`;
  const to = `${y}T23:59:59`;
  const probes = [
    ['vehicles', () => get('/vehicles', { page_number: 1, page_size: 10 })],
    ['drivers', () => get('/drivers', { page_number: 1, page_size: 10 })],
    ['places', () => get('/places', { page_number: 1, page_size: 10 })],
    ['vehicle_groups', () => get('/vehicle-groups')],
    ['alerts', () => get('/alerts')],
    ['alerts_custom', () => get('/alerts/custom')],
    ['event_definitions', () => get('/event-definitions')],
    ['event_definition_types', () => get('/event-definitions/types')],
    ['events_stats', () => get('/events/stats')],
    ['contacts', () => get('/contacts')],
    ['drive_permission_groups', () => get('/drive-permission-group')],
    ['exports', () => get('/exports/status')],
    ['service_centers', () => get('/info/ituran-service-centers')],
    ['bi_groups', () => get('/bi/groups')],
    [
      'trips',
      () =>
        get('/trips', {
          from_date: from,
          to_date: to,
          page_number: 1,
          page_size: 10,
        }),
    ],
    ['trips_totals', () => post('/trips/totals', { from_date: y, to_date: y })],
    [
      'bi_daily_vehicles',
      () =>
        post(
          '/reports/bi/daily/vehicles',
          { from_date: y, to_date: y },
          { page_number: 1, page_size: 10 },
        ),
    ],
    [
      'safety_totals',
      () => post('/safety/totals', { from_date: y, to_date: y }),
    ],
    ['advanced_alerts', () => getAbs('/api/advanced/v1/alerts')],
    ['advanced_entities', () => getAbs('/api/advanced/v1/relations/entities')],
    ['itc_current', () => getAbs('/api/v1/temperatures/current')],
    ['maintenance_types', () => getAbs('/api/v1/maintenance/type')],
  ];
  const c = checks();
  const table = {};
  for (const [name, fn] of probes) {
    const r = await fn();
    const rows = rowsOf(r.json);
    const pg = paginationOf(r.json);
    const out = outcome(r);
    table[name] = {
      status: r.status,
      outcome: out,
      ms: r.ms,
      bytes: r.bytes,
      ...(rows ? { rows: rows.length } : {}),
      ...(pg && typeof pg.block.total_count === 'number'
        ? { total: pg.block.total_count }
        : {}),
      ...(out !== 'available'
        ? { codes: codesOf(r.json), message: scrub(messageOf(r.json) ?? '') }
        : {}),
    };
    if (r.status >= 200 && r.status < 300) ctx.shapes[name] = shape(r.json);
    if (name === 'vehicles') ctx.vehiclesPage1 = r;
    if (name === 'places' && rows?.length) {
      ctx.firstPlace = rows[0]?.place_id ?? rows[0]?.id ?? null;
      ctx.placeNames = rows
        .map((row) => row?.name)
        .filter((n) => typeof n === 'string');
    }
    if (name === 'events_stats' && rows?.length)
      ctx.openEvent =
        [...rows].sort(
          (a, b) => (b?.num_of_vehicles ?? 0) - (a?.num_of_vehicles ?? 0),
        )[0]?.event_id ?? null;
    if (name === 'vehicle_groups' && rows?.length) {
      const top = rows[0];
      ctx.groupId =
        top?.child_groups?.[0]?.vehicle_group_id ??
        top?.vehicle_group_id ??
        null;
    }
    if (name === 'event_definitions' && rows?.length)
      ctx.eventDefinitions = rows;
    if (name === 'drivers') ctx.driversPage1 = r;
    if (name === 'vehicles' && rows?.length)
      ctx.sampleMake = rows.find((v) => v?.make_name)?.make_name ?? null;
  }
  ctx.probes = table;
  c(
    'users and vehicles are available',
    table.vehicles.outcome === 'available',
    table.vehicles.outcome,
  );
  const wrong = Object.entries(table).filter(
    ([, v]) => v.outcome === 'request_rejected',
  );
  c(
    'no probe was malformed (400)',
    wrong.length === 0,
    wrong.map(([k, v]) => `${k}: ${v.codes.join('/')} ${v.message}`).join('; '),
  );
  const blocked = Object.entries(table).filter(([, v]) =>
    ['access_denied', 'pressure_guard', 'unreachable'].includes(v.outcome),
  );
  c(
    'no access-protection, pressure or network failures',
    blocked.length === 0,
    blocked.map(([k, v]) => `${k}: ${v.outcome}`).join('; '),
  );
  const summary = Object.entries(table)
    .map(([k, v]) => `${k}=${v.outcome}`)
    .join(' ');
  return c.result(summary, { entitlements: table });
});

await stage('S7', 'paging', async () => {
  const c = checks();
  const p1 = ctx.vehiclesPage1;
  const pg = paginationOf(p1?.json);
  const rows1 = rowsOf(p1?.json, 'vehicles') || [];
  for (const row of rows1)
    if (typeof row?.license_plate === 'string')
      ctx.plates.add(row.license_plate);
  c('vehicles page 1 has rows', rows1.length > 0, rows1.length);
  c('pagination block present', Boolean(pg), pg?.path ?? 'none');
  const total = pg?.block?.total_count;
  c('total_count is a number', typeof total === 'number', total);
  const p2 = await get('/vehicles', { page_number: 2, page_size: 10 });
  const rows2 = rowsOf(p2.json, 'vehicles') || [];
  for (const row of rows2)
    if (typeof row?.license_plate === 'string')
      ctx.plates.add(row.license_plate);
  const plates1 = new Set(rows1.map((r) => r?.license_plate));
  const overlap = rows2.filter((r) => plates1.has(r?.license_plate)).length;
  if (typeof total === 'number' && total > 10)
    c(
      'page 2 differs from page 1',
      rows2.length > 0 && overlap === 0,
      `${rows2.length} rows, ${overlap} repeated`,
    );
  const small = await get('/vehicles', { page_number: 1, page_size: 5 });
  const big = await get('/vehicles', { page_number: 1, page_size: 2001 });
  const dp = paginationOf(ctx.driversPage1?.json);
  ctx.sample = [...plates1].filter(Boolean).slice(0, 2);
  const plateKinds = {};
  for (const p of ctx.plates) {
    const k = /^\d+$/.test(p)
      ? `digits_${p.length}`
      : /^[0-9A-Z]+$/.test(p)
        ? `alnum_${p.length}`
        : 'other';
    plateKinds[k] = (plateKinds[k] || 0) + 1;
  }
  c(
    'every plate fits one URL segment',
    !plateKinds.other,
    JSON.stringify(plateKinds),
  );
  return c.result(`total ${total}; pagination at ${pg?.path}`, {
    vehicles_total: total ?? null,
    vehicles_pagination_path: pg?.path ?? null,
    vehicles_pagination_keys: pg ? Object.keys(pg.block) : [],
    vehicle_row_keys: rows1[0] ? Object.keys(rows1[0]) : [],
    page_size_5_status: small.status,
    page_size_5_codes: codesOf(small.json),
    page_size_2001_status: big.status,
    page_size_2001_codes: codesOf(big.json),
    drivers_pagination_path: dp?.path ?? null,
    plate_kinds: plateKinds,
  });
});

await stage('S8', 'errors', async () => {
  const c = checks();
  const unknown = await get(`/vehicles/${BOGUS_PLATE}/location`);
  const route = await get('/ituran-live-no-such-route');
  const stats = await get('/trips/stats', {
    from_date: `${localDate(-1)}T00:00:00`,
    to_date: `${localDate(-1)}T23:59:59`,
  });
  c(
    'unknown plate refused (403 or 404)',
    [403, 404].includes(unknown.status),
    unknown.status,
  );
  c('unknown route 404', route.status === 404, route.status);
  c('missing required parameter 400', stats.status === 400, stats.status);
  const env1 = (r) => ({
    status: r.status,
    codes: codesOf(r.json),
    keys:
      r.json && typeof r.json === 'object'
        ? Object.keys(r.json)
        : `${r.bytes} bytes, not JSON`,
    message: scrub(messageOf(r.json) ?? ''),
  });
  return c.result('error envelopes recorded', {
    error_unknown_plate: env1(unknown),
    error_unknown_route: env1(route),
    error_missing_parameter: env1(stats),
  });
});

await stage('S9', 'vehicle reads', async () => {
  const c = checks();
  const [p1, p2] = ctx.sample;
  if (!p1) return { status: 'blocked', detail: 'no vehicle to read' };
  const facts = {};
  const t = (name, r) => {
    facts[`${name}_status`] = r.status;
    facts[`${name}_ms`] = r.ms;
    if (r.status >= 200 && r.status < 300 && r.json !== undefined)
      ctx.shapes[name] = shape(r.json);
    else if (r.status >= 400) facts[`${name}_codes`] = codesOf(r.json);
    return r;
  };
  const detail = t('vehicle', await get(`/vehicles/${enc(p1)}`));
  c('vehicle detail 200', detail.status === 200, detail.status);
  const loc = t('vehicle_location', await get(`/vehicles/${enc(p1)}/location`));
  c('vehicle location 200', loc.status === 200, loc.status);
  let pointPath = null;
  const findPoint = (v, path) => {
    if (pointPath || !v || typeof v !== 'object') return;
    if ('latitude' in v || 'lat' in v) {
      pointPath = path || '(root)';
      return;
    }
    for (const [k, x] of Object.entries(v))
      findPoint(x, path ? `${path}.${k}` : k);
  };
  findPoint(loc.json, '');
  const at = loc.json?.location?.point;
  if (
    typeof at?.lat === 'number' &&
    typeof at?.lon === 'number' &&
    (at.lat || at.lon)
  )
    ctx.samplePoint = `${at.lat},${at.lon}`;
  facts.location_point_path = pointPath;
  // One read with the realtime blocks: last position with address, driver, and the
  // saved places the vehicle is in. ituran-axi builds `vehicle` and `where` on it.
  const RT = ['LastLocation', 'Driver', 'Places'];
  const rt = t(
    'vehicle_realtime',
    await get(`/vehicles/${enc(p1)}`, { realtime_fields: RT }),
  );
  c('vehicle with realtime blocks 200', rt.status === 200, rt.status);
  facts.vehicle_realtime_keys =
    rt.json && typeof rt.json === 'object' ? Object.keys(rt.json) : null;
  const rtList = t(
    'vehicles_realtime',
    await get('/vehicles', {
      page_number: 1,
      page_size: 10,
      realtime_fields: RT,
    }),
  );
  c(
    'vehicle list with realtime blocks 200',
    rtList.status === 200,
    rtList.status,
  );
  const rtRows = rowsOf(rtList.json, 'vehicles') || [];
  facts.vehicles_realtime_with_location = rtRows.filter(
    (r) => r?.last_location,
  ).length;
  facts.vehicles_realtime_with_places = rtRows.filter(
    (r) => Array.isArray(r?.places) && r.places.length,
  ).length;
  const drv = t('vehicle_driver', await get(`/vehicles/${enc(p1)}/driver`));
  c(
    'vehicle driver 200 or 404 (no driver)',
    [200, 404].includes(drv.status),
    drv.status,
  );
  // Positions of chosen vehicles in one read: the search route takes the realtime blocks too.
  const many = t(
    'vehicles_search_realtime',
    await post(
      '/vehicles/search',
      { license_plates: [p1, p2].filter(Boolean) },
      { page_number: 1, page_size: 10, realtime_fields: ['LastLocation'] },
    ),
  );
  c('search by plates with positions 200', many.status === 200, many.status);
  const manyRows = rowsOf(many.json, 'vehicles') || [];
  facts.vehicles_search_realtime_rows = manyRows.length;
  facts.vehicles_search_realtime_with_location = manyRows.filter(
    (r) => r?.last_location,
  ).length;
  // Text search: wildcard_filter {license_plate|nickname} contains-matches server-side.
  const part = p1.slice(0, 3);
  const search = t(
    'vehicles_search',
    await post(
      '/vehicles/search',
      { wildcard_filter: { license_plate: part } },
      { page_number: 1, page_size: 10 },
    ),
  );
  c('plate-part search 200', search.status === 200, search.status);
  facts.vehicles_search_rows = rowsOf(search.json, 'vehicles')?.length ?? null;
  facts.vehicles_search_total =
    paginationOf(search.json)?.block?.total_count ?? null;
  const none = t(
    'vehicles_search_none',
    await post(
      '/vehicles/search',
      { wildcard_filter: { nickname: 'ituran-live-no-such-vehicle' } },
      { page_number: 1, page_size: 10 },
    ),
  );
  c(
    'a search with no match answers 404 404.3 or an empty list',
    none.status === 404 ||
      (none.status === 200 &&
        (rowsOf(none.json, 'vehicles') || []).length === 0),
    none.status,
  );
  facts.vehicles_search_none_codes = codesOf(none.json);
  const from = `${localDate(-3)}T00:00:00`;
  const to = localNow(-2);
  const trips = t(
    'trips_vehicle',
    await get('/trips', {
      license_plates: p1,
      from_date: from,
      to_date: to,
      page_number: 1,
      page_size: 10,
    }),
  );
  c(
    'trips for one vehicle 200 or 404.1',
    trips.status === 200 || trips.status === 404,
    trips.status,
  );
  const tripRows = rowsOf(trips.json, 'trips') || [];
  facts.trips_vehicle_rows = tripRows.length;
  facts.trips_pagination_path = paginationOf(trips.json)?.path ?? null;
  ctx.firstTrip = tripRows[0]?.trip_id ?? tripRows[0]?.id ?? null;
  const tstats = t(
    'trips_stats',
    await get('/trips/stats', {
      license_plate: p1,
      from_date: from,
      to_date: to,
    }),
  );
  c(
    'trip stats 200',
    tstats.status === 200 || tstats.status === 404,
    tstats.status,
  );
  const diag = t(
    'diagnostics_last',
    await post(
      '/diagnostics',
      { filter: { license_plates: [p1] } },
      { page_number: 1, page_size: 10 },
    ),
  );
  c('last diagnostics 200', diag.status === 200, diag.status);
  const odo = t(
    'virtual_odometer',
    await post('/virtual-odometer', { license_plates: [p1], page_size: 10 }),
  );
  c(
    'virtual odometer 200',
    odo.status === 200 || odo.status === 404,
    odo.status,
  );
  const cmds = t(
    'commands_catalog',
    await get('/commands', { license_plate: p1 }),
  );
  facts.commands_catalog_rows = rowsOf(cmds.json)?.length ?? null;
  if (ctx.firstTrip !== null) {
    const trip = t('trip', await get(`/trips/${enc(String(ctx.firstTrip))}`));
    c('trip detail 200', trip.status === 200, trip.status);
    const pts = t(
      'trip_points',
      await get(`/trips/${enc(String(ctx.firstTrip))}/points`, {
        page_number: 1,
        page_size: 10,
      }),
    );
    c('trip points 200', pts.status === 200, pts.status);
  }
  if (ctx.firstPlace !== null && ctx.firstPlace !== undefined) {
    // Upstream answers this route at very different speeds (2 s to over 60 s on production), so a
    // timeout is recorded as a fact rather than a failure.
    const inside = t(
      'place_vehicles',
      await get(`/places/${enc(String(ctx.firstPlace))}/vehicles`, undefined, {
        timeout: 90_000,
      }),
    );
    c(
      'vehicles inside a place 200 or timed out',
      inside.status === 200 || inside.error === 'timeout',
      inside.status || inside.error,
    );
    facts.place_vehicles_timed_out = inside.error === 'timeout';
  }
  return c.result(
    `2 sample vehicles; ${tripRows.length} trips in 3 days for the first`,
    facts,
  );
});

if (args.deep) {
  await stage('S9b', 'deep reads', async () => {
    const c = checks();
    const [p1] = ctx.sample;
    if (!p1) return { status: 'blocked', detail: 'no vehicle to read' };
    const y = localDate(-1);
    const facts = {};
    const t = (name, r) => {
      facts[`${name}_status`] = r.status;
      facts[`${name}_ms`] = r.ms;
      if (r.status >= 200 && r.status < 300 && r.json !== undefined)
        ctx.shapes[name] = shape(r.json);
      else if (r.status >= 400) facts[`${name}_codes`] = codesOf(r.json);
      return r;
    };
    if (ctx.firstTrip !== null) {
      const s = t(
        'trip_safety',
        await get(`/trips/${enc(String(ctx.firstTrip))}/safety`),
      );
      c('trip safety 200 or 404', [200, 404].includes(s.status), s.status);
    }
    const heat = t(
      'heat_map',
      await post('/reports/heat-map', {
        license_plate: p1,
        from_date: `${y}T00:00:00`,
        to_date: `${y}T23:59:59`,
      }),
    );
    c('heat map 200', heat.status === 200, heat.status);
    const ev = t(
      'events_report',
      await post('/reports/events-report', {
        license_plates: [p1],
        from_date: `${y}T00:00:00`,
        to_date: `${y}T23:59:59`,
        records_limit: 10,
      }),
    );
    c('events report 200', ev.status === 200, ev.status);
    const hist = t(
      'diagnostics_history',
      await post(
        '/diagnostics/history',
        {
          filter: {
            license_plates: [p1],
            from_date: `${y}T00:00:00`,
            to_date: `${y}T23:59:59`,
          },
        },
        { page_number: 1, page_size: 10 },
      ),
    );
    c(
      'diagnostics history 200',
      hist.status === 200 || hist.status === 404,
      hist.status,
    );
    const def = (ctx.eventDefinitions || []).find(
      (d) => d?.event_id !== undefined || d?.id !== undefined,
    );
    if (def) {
      const id = def.event_id ?? def.id;
      const vs = t(
        'event_vehicles',
        await get(`/events/${enc(String(id))}/vehicles`),
      );
      c(
        'event drill-down 200',
        vs.status === 200 || vs.status === 404,
        vs.status,
      );
    }
    const drivers = t(
      'bi_daily_drivers',
      await post(
        '/reports/bi/daily/drivers',
        { from_date: y, to_date: y },
        { page_number: 1, page_size: 10 },
      ),
    );
    c('BI daily drivers answered', drivers.status > 0, drivers.status);
    const sv = t(
      'safety_vehicles',
      await post(
        '/safety/vehicles',
        { from_date: y, to_date: y },
        { page_number: 1, page_size: 10 },
      ),
    );
    c('safety per vehicle answered', sv.status > 0, sv.status);
    return c.result('deep reads recorded', facts);
  });
}

await stage('S10', 'transport', async () => {
  const c = checks();
  const reqs = ctx.requests.filter((r) => !r.grant && r.status > 0);
  const ms = reqs.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p) =>
    ms.length
      ? ms[Math.min(ms.length - 1, Math.floor((p / 100) * ms.length))]
      : null;
  const statuses = {};
  for (const r of ctx.requests)
    statuses[r.status] = (statuses[r.status] || 0) + 1;
  const encodings = [...new Set(reqs.map((r) => r.encoding).filter(Boolean))];
  const limitHeaders = [
    ...new Set(
      reqs.flatMap((r) =>
        (r.headerNames || []).filter((h) =>
          /rate|limit|retry|quota|throttl/i.test(h),
        ),
      ),
    ),
  ];
  c('no HTTP 481 (pressure guard)', !statuses[481], statuses[481] || 0);
  c('no HTTP 474 (access protection)', !statuses[474], statuses[474] || 0);
  c('no HTTP 429', !statuses[429], statuses[429] || 0);
  return c.result(
    `${ctx.requests.length} requests; p50 ${pct(50)} ms, p90 ${pct(90)} ms, max ${ms.at(-1)} ms`,
    {
      requests: ctx.requests.length,
      grants: ctx.requests.filter((r) => r.grant).length,
      statuses,
      latency_ms: { p50: pct(50), p90: pct(90), max: ms.at(-1) ?? null },
      largest_response_bytes: Math.max(0, ...reqs.map((r) => r.bytes)),
      content_encodings: encodings,
      limit_headers: limitHeaders,
      big_integers_seen: ctx.bigInts,
      hebrew_strings_seen: ctx.hebrewStrings,
      bidi_or_zero_width_strings_seen: ctx.bidiControls,
      date_fields: Object.fromEntries(
        Object.entries(ctx.dateFields).map(([k, v]) => [k, [...v]]),
      ),
    },
  );
});

/** Run the built ituran-axi once with this run's token and a private cache. */
function runAxi(entry, argv, cache) {
  return new Promise((done) => {
    const started = performance.now();
    const child = spawn(process.execPath, [entry, ...argv], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        XDG_CACHE_HOME: cache,
        ITURAN_URL: cfg.base,
        ITURAN_TOKEN: ctx.token,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 240_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({
        code,
        stdout,
        stderr,
        ms: Math.round(performance.now() - started),
      });
    });
  });
}

const axiEntry = () =>
  args.axi === 'none'
    ? null
    : resolve(args.axi || join(ROOT, 'dist/bin/ituran-axi.js'));

// S11: the built ituran-axi against the live API, with the token this run holds.
await stage('S11', 'AXI smoke', async () => {
  const entry =
    args.axi === 'none'
      ? null
      : resolve(args.axi || join(ROOT, 'dist/bin/ituran-axi.js'));
  if (!entry || !existsSync(entry))
    return {
      status: 'skip',
      detail: entry ? 'ituran-axi is not built yet' : '--axi none',
    };
  if (!ctx.token) return { status: 'skip', detail: 'no token' };
  const [p1] = ctx.sample;
  const y = localDate(-1);
  const runs = [
    { argv: [], exit: 0, expect: /^vehicles: \d+$/m },
    {
      argv: ['vehicles', '--limit', '3'],
      exit: 0,
      expect: /^vehicles\[3\]\{plate,name,model,status\}:/m,
    },
    ...(p1
      ? [
          {
            argv: ['vehicles', p1.slice(0, 4)],
            exit: 0,
            expect: /with \d+ in the plate/,
          },
          { argv: ['vehicle', p1], exit: 0, expect: /^plate: "?\w+"?$/m },
          { argv: ['where', p1], exit: 0, expect: /^summary: "?1 vehicle/m },
          {
            argv: ['trips', p1, '--since', '3d'],
            exit: 0,
            expect: /trips\[\d+|0 trips/,
          },
          {
            argv: ['totals', p1, '--since', '3d'],
            exit: 0,
            expect: /^trips: \d+$/m,
          },
          { argv: ['odometer', p1], exit: 0, expect: /odometers\[/ },
          {
            argv: ['diagnostics', p1, '--limit', '5'],
            exit: 0,
            expect: /latest readings/,
          },
          {
            argv: ['report', 'events', p1, '--date', y, '--limit', '5'],
            exit: 0,
            expect: /records of the events report/,
          },
          {
            argv: ['report', 'heat-map', p1, '--date', y, '--limit', '5'],
            exit: 0,
            expect: /heat-map points/,
          },
        ]
      : []),
    {
      argv: ['where', '--all', '--limit', '5'],
      exit: 0,
      expect: /^summary: "?\d+ vehicles · /m,
    },
    { argv: ['totals', '--date', y], exit: 0, expect: /^trips: \d+$/m },
    { argv: ['drivers', '--limit', '3'], exit: 0, expect: /drivers\[3\]/ },
    { argv: ['places', '--limit', '3'], exit: 0, expect: /places\[3\]/ },
    { argv: ['groups'], exit: 0, expect: /groups\[\d+\]/ },
    { argv: ['events', '--limit', '5'], exit: 0, expect: /event states/ },
    { argv: ['alerts'], exit: 0, expect: /alert definitions/ },
    {
      argv: ['report', 'daily', '--date', y, '--limit', '3'],
      exit: 0,
      expect: /of the daily report by vehicle/,
    },
    {
      argv: ['safety', '--date', y],
      exit: 0,
      expect: /safety grade|no safety data/,
    },
    {
      argv: ['safety', 'vehicles', '--date', y, '--limit', '3'],
      exit: 0,
      expect: /of safety vehicles/,
    },
    {
      argv: ['maintenance', '--types', '--limit', '3'],
      exit: 0,
      expect: /treatment type/,
    },
    {
      argv: ['temps'],
      exit: [0, 1],
      expect: /sensor readings|code: not_entitled/,
    },
    {
      argv: ['vehicle', BOGUS_PLATE],
      exit: 1,
      expect: /code: (not_visible|not_found)/,
    },
    { argv: ['no-such-command'], exit: 2, expect: /code: usage/ },
    { argv: ['vehicles', '--no-such-flag'], exit: 2, expect: /code: usage/ },
  ];
  const c = checks();
  // A private, empty cache: S11 never reuses another run's state.
  const axiCache = mkdtempSync(join(tmpdir(), 'ituran-live-axi-'));
  for (const run of runs) {
    const out = await runAxi(entry, run.argv, axiCache);
    const label =
      `ituran-axi ${run.argv.map((a) => (a === p1 ? '<plate>' : a === p1?.slice(0, 4) ? '<plate part>' : a)).join(' ')}`.trim();
    const exits = Array.isArray(run.exit) ? run.exit : [run.exit];
    const shaped = run.expect.test(out.stdout);
    c(
      `${label} exits ${exits.join(' or ')}`,
      exits.includes(out.code),
      out.code,
    );
    // Output is recorded only when a check fails: it holds the account's data.
    c(
      `${label} prints the expected TOON`,
      shaped,
      shaped ? undefined : out.stdout.slice(0, 200),
    );
    c(
      `${label} stays under 4,000 characters`,
      out.stdout.length <= 4000,
      out.stdout.length,
    );
    c(
      `${label} writes nothing to stderr`,
      out.stderr === '',
      out.stderr ? 'stderr' : undefined,
    );
  }
  return c.result(`${runs.length} commands`);
});

// S12: ituran-mcp, read-only, as the reference the AXI is converted from.
await stage('S12', 'MCP parity', async () => {
  if (!args.parity) return { status: 'skip', detail: 'run with --parity' };
  if (cfg.token)
    return { status: 'skip', detail: 'needs a username and password' };
  const c = checks();
  const child = spawn('npx', ['-y', `ituran-mcp@${MCP_VERSION}`], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ITURAN_USERNAME: cfg.user,
      ITURAN_PASSWORD: cfg.password,
      ITURAN_GLOBAL_BASE_URL: cfg.base,
      ITURAN_ALLOW_MUTATIONS: 'false',
      ITURAN_TOOL_FAMILIES: 'vehicles,users',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let buf = '';
  let exited = null;
  child.stdout.on('data', (d) => {
    buf += d;
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const m = JSON.parse(line);
        if (m.id !== undefined && pending.has(m.id)) {
          pending.get(m.id)(m);
          pending.delete(m.id);
        }
      } catch {
        /* not a JSON-RPC line */
      }
      i = buf.indexOf('\n');
    }
  });
  child.stderr.on('data', () => {});
  child.on('exit', (code) => {
    exited = code;
    for (const done of pending.values())
      done({ error: { message: `ituran-mcp exited ${code}` } });
    pending.clear();
  });
  let nextId = 1;
  const rpc = (method, params) =>
    new Promise((done) => {
      if (exited !== null)
        return done({ error: { message: `ituran-mcp exited ${exited}` } });
      const id = nextId++;
      pending.set(id, done);
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
      );
    });
  const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
  try {
    const init = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'ituran-live', version: VERSION },
    });
    c('ituran-mcp starts and signs in', !init.error, init.error?.message);
    if (init.error) return c.result('');
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`,
    );
    const list = await rpc('tools/list', {});
    const tools = list.result?.tools ?? [];
    c('tools listed', tools.length > 0, tools.length);
    const parse = (m) => {
      try {
        return JSON.parse(m.result?.content?.[0]?.text ?? 'null');
      } catch {
        return null;
      }
    };
    const vl = parse(
      await rpc('tools/call', {
        name: 'ituran_vehicles_list',
        arguments: { page_size: 10 },
      }),
    );
    const mcpTotal =
      paginationOf(vl)?.block?.total_count ??
      vl?._pagination?.total_count ??
      null;
    const direct = ctx.probes.vehicles?.total ?? null;
    c(
      'vehicle total matches the direct read',
      mcpTotal === direct,
      `${mcpTotal} vs ${direct}`,
    );
    const me = parse(
      await rpc('tools/call', { name: 'ituran_users_me', arguments: {} }),
    );
    c(
      'users_me answered',
      me && typeof me === 'object',
      me ? 'object' : 'none',
    );
    return c.result(`${tools.length} tools; totals match`, {
      mcp_version: MCP_VERSION,
      mcp_tools_listed: tools.length,
      mcp_tool_names: tools.map((x) => x.name),
      mcp_vehicles_total: mcpTotal,
      mcp_users_me_keys: me && typeof me === 'object' ? Object.keys(me) : null,
    });
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    child.kill();
  }
});

// S13: every request this run made, judged by the draft Comis Gate entry.
await stage(
  'S13',
  'Gate rules',
  async () => {
    const file = resolve(
      args['gate-entry'] || join(ROOT, 'comis/key-services/ituran.json'),
    );
    if (!existsSync(file))
      return { status: 'skip', detail: 'no draft Gate entry' };
    const entry = JSON.parse(readFileSync(file, 'utf8'));
    const SEG = /^[A-Za-z0-9._~-]+$/;
    const segMatch = (p, s) => {
      if (p.startsWith('{') && p.endsWith('}')) {
        const inner = p.slice(1, -1);
        return inner.includes('|') ? inner.split('|').includes(s) : SEG.test(s);
      }
      return p === s;
    };
    const pathMatch = (pattern, path) => {
      if (pattern === '*') return true;
      const ps = pattern.split('/').slice(1);
      const xs = path.split('/').slice(1);
      for (let i = 0; i < ps.length; i++) {
        if (/^\{[A-Za-z_]+\.\.\.\}$/.test(ps[i]))
          return (
            i === ps.length - 1 &&
            xs.length > i &&
            xs.slice(i).every((s) => SEG.test(s))
          );
        if (i >= xs.length || !segMatch(ps[i], xs[i])) return false;
      }
      return ps.length === xs.length;
    };
    const rule = (r, method, path) => {
      const [m, p] = r.split(' ');
      return (m === '*' || m === method) && pathMatch(p, path);
    };
    const judge = (method, path) => {
      const credentialed = entry.credential.match.some((r) =>
        rule(r, method, path),
      );
      if (['GET', 'HEAD', 'OPTIONS'].includes(method))
        return { credentialed, decide: 'read' };
      if ((entry.reads || []).some((r) => rule(r, method, path)))
        return { credentialed, decide: 'read' };
      const w = (entry.writes || []).find((x) => rule(x.match, method, path));
      return { credentialed, decide: w ? w.decide : 'deny' };
    };
    const c = checks();
    const template = (path) =>
      path
        .split('/')
        .map((s) => {
          const d = decodeURIComponent(s);
          if (ctx.plates.has(d) || d === BOGUS_PLATE) return '{plate}';
          if (/^-?\d+$/.test(d) || /^[0-9a-f-]{16,}$/i.test(d)) return '{id}';
          return s;
        })
        .join('/');
    const seen = new Map();
    for (const r of ctx.requests) {
      if (r.grant) continue;
      const key = `${r.method} ${r.path}`;
      if (!seen.has(key)) seen.set(key, r);
    }
    const uncovered = [];
    // Probed only to record entitlements or errors; ituran-axi never calls them,
    // so the draft entry gives them no token.
    const probeOnly = new Set([
      '/api/v2/ituran-live-no-such-route',
      '/api/v2/contacts',
      '/api/v2/drive-permission-group',
    ]);
    for (const [, r] of seen) {
      const v = judge(r.method, r.path);
      const ok = v.credentialed && v.decide === 'read';
      if (probeOnly.has(r.path)) {
        if (v.credentialed)
          uncovered.push(
            `${r.method} ${template(r.path)} (probe-only route is credentialed)`,
          );
        continue;
      }
      if (!ok)
        uncovered.push(
          `${r.method} ${template(r.path)} (${v.credentialed ? v.decide : 'no token'})`,
        );
    }
    c(
      'every read this run made is credentialed and passes as a read',
      uncovered.length === 0,
      [...new Set(uncovered)].join('; '),
    );
    const identityPath = new URL(tokenUrl()).pathname;
    const id = judge('POST', identityPath);
    c(
      'the token route never gets the token and is denied',
      !id.credentialed && id.decide === 'deny',
      JSON.stringify(id),
    );
    const writes = [
      ['POST', '/api/v2/commands/send'],
      ['POST', '/api/v2/commands/start-tracking'],
      ['POST', '/api/v2/vehicles/1234567/share-drive'],
      ['POST', '/api/v2/places'],
      ['PUT', '/api/v2/places/1'],
      ['DELETE', '/api/v2/alerts/1'],
      ['PATCH', '/api/v2/vehicle-groups/1'],
      ['PUT', '/api/v2/users/me/password'],
      ['POST', '/api/v2/drive-permission-group'],
      ['GET', '/api/v1/oauth/token'],
    ];
    const leaks = writes.filter(([m, p]) => {
      const v = judge(m, p);
      return m === 'GET' ? v.credentialed : v.decide !== 'deny';
    });
    c(
      'writes, commands and identity routes are denied',
      leaks.length === 0,
      leaks.map((x) => x.join(' ')).join('; '),
    );
    return c.result(`${seen.size} routes checked`, {
      gate_routes_checked: seen.size,
      gate_routes: [
        ...new Set(
          [...seen.values()].map((r) => `${r.method} ${template(r.path)}`),
        ),
      ].sort(),
    });
  },
  { always: true },
);

// S14: the use cases. Each question's commands, run with the built AXI.
const NOT_HERE = /^code: (not_entitled|feature_off|needs_app_id)$/m;

function weekday(date, day) {
  // The latest date before `date` that falls on `day` (0 Sunday .. 6 Saturday).
  const t = new Date(`${date}T12:00:00Z`);
  do t.setUTCDate(t.getUTCDate() - 1);
  while (t.getUTCDay() !== day);
  return t.toISOString().slice(0, 10);
}

function monthBounds(today, back) {
  const t = new Date(`${today.slice(0, 7)}-01T12:00:00Z`);
  t.setUTCMonth(t.getUTCMonth() - back);
  const first = t.toISOString().slice(0, 10);
  t.setUTCMonth(t.getUTCMonth() + 1);
  t.setUTCDate(0);
  return [first, t.toISOString().slice(0, 10)];
}

await stage('S14', 'use cases', async () => {
  if (!args['use-cases'])
    return { status: 'skip', detail: 'run with --use-cases' };
  const entry = axiEntry();
  if (!entry || !existsSync(entry))
    return { status: 'skip', detail: 'ituran-axi is not built yet' };
  if (!ctx.token) return { status: 'skip', detail: 'no token' };
  const [P, P2] = ctx.sample;
  const today = localDate(0);
  // A whole word of three or more letters or digits from any saved place's
  // name on the first page: some names have none.
  const word = (ctx.placeNames ?? [])
    .flatMap((n) => n.split(/\s+/))
    .find((w) => /^[\p{L}\p{N}]{3,}$/u.test(w));
  const [M1, E1] = monthBounds(today, 1);
  const [M2, E2] = monthBounds(today, 2);
  const [M3, E3] = monthBounds(today, 3);
  const v = {
    P,
    P2: P2 ?? P,
    PART: P?.slice(0, 4),
    TRIP:
      ctx.firstTrip === null || ctx.firstTrip === undefined
        ? undefined
        : String(ctx.firstTrip),
    PLACE:
      ctx.firstPlace === null || ctx.firstPlace === undefined
        ? undefined
        : String(ctx.firstPlace),
    PLACEWORD: word,
    EVENT:
      ctx.openEvent === null || ctx.openEvent === undefined
        ? undefined
        : String(ctx.openEvent),
    GROUP:
      ctx.groupId === null || ctx.groupId === undefined
        ? undefined
        : String(ctx.groupId),
    MAKE: ctx.sampleMake ?? undefined,
    POINT: ctx.samplePoint,
    Y: localDate(-1),
    TODAY: today,
    SAT: weekday(today, 6),
    WED: weekday(today, 3),
    D15: localDate(-15),
    D16: localDate(-16),
    D30: localDate(-30),
    D31: localDate(-31),
    D60: localDate(-60),
    M1,
    E1,
    M2,
    E2,
    M3,
    E3,
  };
  const missing = Object.entries(v)
    .filter(([, x]) => !x)
    .map(([k]) => k);
  const cases = useCases(v);
  // Names for values that identify the account's data, for the report.
  const names = new Map(
    [
      'P',
      'P2',
      'PART',
      'TRIP',
      'PLACE',
      'PLACEWORD',
      'EVENT',
      'GROUP',
      'MAKE',
      'POINT',
    ]
      .filter((k) => v[k])
      .map((k) => [v[k], `<${k}>`]),
  );
  const shown = (argv) =>
    argv
      .map(
        (a) =>
          names.get(a) ??
          (typeof a === 'string' && P && a.includes(P)
            ? a.replaceAll(P, '<P>')
            : a),
      )
      .join(' ');
  const cache = mkdtempSync(join(tmpdir(), 'ituran-live-cases-'));
  const done = new Map();
  const outcomes = [];
  let commands = 0;
  for (const uc of cases) {
    const runs = [];
    for (const argv of uc.runs) {
      if (argv.some((a) => a === undefined)) {
        runs.push({
          argv: shown(argv.map((a) => a ?? '<none>')),
          state: 'blocked',
          why: 'no sample value',
        });
        continue;
      }
      const key = JSON.stringify(argv);
      let out = done.get(key);
      if (!out) {
        await sleep(GAP_MS);
        out = await runAxi(entry, argv, cache);
        done.set(key, out);
        commands++;
      }
      const full = argv.includes('--full');
      const error = /^code: ([a-z_]+)$/m.exec(out.stdout)?.[1];
      const bounded = full
        ? Buffer.byteLength(out.stdout) <= 262_144
        : out.stdout.length <= 4000;
      const state =
        out.code === 0 && bounded && out.stderr === ''
          ? 'pass'
          : out.code === 1 && NOT_HERE.test(out.stdout)
            ? 'account'
            : 'fail';
      runs.push({
        argv: shown(argv),
        state,
        exit: out.code,
        ms: out.ms,
        ...(error ? { error } : {}),
        ...(state === 'fail' && !bounded
          ? { why: `output ${out.stdout.length} characters` }
          : {}),
        ...(state === 'fail' && error
          ? {
              why: scrub(/^message: (.*)$/m.exec(out.stdout)?.[1] ?? '').slice(
                0,
                200,
              ),
            }
          : {}),
      });
    }
    const status = runs.some((r) => r.state === 'fail')
      ? 'fail'
      : runs.some((r) => r.state === 'blocked')
        ? 'blocked'
        : runs.some((r) => r.state === 'account')
          ? 'not on this account'
          : 'answered';
    outcomes.push({
      n: uc.n,
      area: AREAS[uc.area],
      title: uc.title,
      status,
      runs,
    });
  }
  const count = (st) => outcomes.filter((o) => o.status === st).length;
  const failed = outcomes.filter((o) => o.status === 'fail');
  const blocked = outcomes.filter((o) => o.status === 'blocked');
  const c = checks();
  c(
    'every use case is answered or names a service the account lacks',
    failed.length === 0,
    failed
      .map(
        (o) =>
          `${o.n}: ${o.runs
            .filter((r) => r.state === 'fail')
            .map(
              (r) =>
                `${r.argv} -> ${r.error ?? r.exit}${r.why ? ` (${r.why})` : ''}`,
            )
            .join('; ')}`,
      )
      .join(' | '),
  );
  const r = c.result(
    `${outcomes.length} use cases, ${commands} commands: ${count('answered')} answered, ${count('not on this account')} not on this account, ${blocked.length} blocked, ${failed.length} failed`,
    {
      use_cases_answered: count('answered'),
      use_cases_not_on_account: count('not on this account'),
      use_cases_blocked: blocked.length,
      use_cases_failed: failed.length,
      use_cases_commands: commands,
      use_cases_missing_samples: missing,
      use_cases: outcomes,
    },
  );
  if (r.status === 'pass' && blocked.length) r.status = 'blocked';
  return r;
});

// ---------- report ----------

const finishedAt = new Date();
const count = (st) => results.filter((r) => r.status === st).length;
const summary = {
  pass: count('pass'),
  fail: count('fail'),
  blocked: count('blocked'),
  skip: count('skip'),
};
const facts = Object.assign({}, ...results.map((r) => r.facts));

const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
const reportPath = args.report || join(HERE, 'reports', `${stamp}.json`);
const report = {
  tool: 'ituran-live',
  version: VERSION,
  started_at: startedAt.toISOString(),
  finished_at: finishedAt.toISOString(),
  target: {
    base: cfg.base,
    environment: env,
    user: cfg.user || null,
    sign_in: cfg.token ? 'token' : 'password_grant',
  },
  options: {
    strict: Boolean(args.strict),
    deep: Boolean(args.deep),
    parity: Boolean(args.parity),
  },
  summary,
  stages: results,
  facts,
  shapes: ctx.shapes,
};
let reportNote = '';
try {
  mkdirSync(dirname(reportPath), { recursive: true });
  const tmp = `${reportPath}.tmp`;
  writeFileSync(tmp, `${scrub(JSON.stringify(report, null, 2))}\n`, {
    mode: 0o600,
  });
  renameSync(tmp, reportPath);
  const rel = relative(process.cwd(), reportPath);
  reportNote = rel && !rel.startsWith('..') ? rel : reportPath;
} catch (e) {
  reportNote = `not written: ${e.message}`;
}

const lines = [];
lines.push(`ituran_live: ${cell(`${cfg.base} · ${env}`)}`);
lines.push(`stages[${results.length}]{id,stage,status,ms,detail}:`);
for (const r of results)
  lines.push(
    `  ${[r.id, r.name, r.status, r.ms, r.detail].map(cell).join(',')}`,
  );
const failedChecks = results.flatMap((r) =>
  r.checks.filter((x) => !x.ok).map((x) => ({ id: r.id, ...x })),
);
if (failedChecks.length) {
  lines.push(`failed_checks[${failedChecks.length}]{stage,check,got}:`);
  for (const f of failedChecks)
    lines.push(`  ${[f.id, f.name, f.got ?? ''].map(cell).join(',')}`);
}
const flat = Object.entries(facts).filter(
  ([, v]) => v !== undefined && (typeof v !== 'object' || v === null),
);
if (flat.length) {
  lines.push('facts:');
  for (const [k, v] of flat) lines.push(`  ${k}: ${cell(v)}`);
}
lines.push(
  `summary: ${summary.pass} pass, ${summary.fail} fail, ${summary.blocked} blocked, ${summary.skip} skip`,
);
lines.push(`report: ${cell(reportNote)}`);
const help = [];
if (results[0]?.status === 'fail')
  help.push(
    'Set ITURAN_GLOBAL_BASE_URL and ITURAN_USERNAME and ITURAN_PASSWORD (see test/live/.env.example)',
  );
if (summary.fail) help.push('See failed_checks above and the JSON report');
if (!args.parity && !ctx.abort)
  help.push('Run with --parity to compare against ituran-mcp');
if (help.length) {
  lines.push(`help[${help.length}]:`);
  for (const h of help) lines.push(`  ${h}`);
}
console.log(scrub(lines.join('\n')));

process.exit(summary.fail || (args.strict && summary.blocked) ? 1 : 0);
