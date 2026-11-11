// What every command shares: settings and sign-in, the account, flags, paging
// over Ituran's 10-to-2000 page sizes, and the bounded list and record views.

import { homedir } from 'node:os';
import { type Account, cacheDir, loadAccount } from '../account.ts';
import { sessionFor } from '../auth.ts';
import type { CommandInput } from '../cli/table.ts';
import { type Auth, connected, type Settings } from '../config.ts';
import { AxiError, usage } from '../errors.ts';
import { Client } from '../http.ts';
import { bounded, cut, render } from '../output/toon.ts';

export type Row = Record<string, unknown>;

export interface Ctx {
  settings: Settings & { auth: Auth };
  client: Client;
  dir: string;
  input: CommandInput;
  now: Date;
}

export function open(input: CommandInput): Ctx {
  const settings = connected(input.io.env);
  const session = sessionFor(
    settings,
    input.io.http,
    input.io.env,
    input.io.now,
  );
  return {
    settings,
    client: new Client(settings, session, input.io.http, input.io.now),
    dir: cacheDir(settings, input.io.env),
    input,
    now: input.io.now(),
  };
}

export function account(ctx: Ctx, fresh = false): Promise<Account> {
  return loadAccount(ctx.client, ctx.dir, ctx.now, fresh);
}

/** An absolute path below the API root, such as /api/v2/vehicles. */
export const api = (ctx: Ctx, path: string): string =>
  `${ctx.settings.basePath}${path}`;

export const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined;

export const strings = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string')
    : typeof v === 'string'
      ? [v]
      : [];

export function intFlag(
  v: unknown,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (v === undefined) return fallback;
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw usage(`--${name} takes a whole number from ${min} to ${max}.`);
  }
  return n;
}

const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** A shell word: bare when safe, otherwise single-quoted. */
export function shellWord(word: string): string {
  return SAFE_WORD.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The rows of a list answer: the named key, or the first array in it. */
export function rowsOf(json: unknown, key: string): Row[] {
  if (json === null || json === undefined) return [];
  if (Array.isArray(json))
    return json.filter((r): r is Row => !!r && typeof r === 'object');
  if (typeof json !== 'object') {
    throw new AxiError(
      'ituran_error',
      'Ituran sent an answer ituran-axi cannot read.',
    );
  }
  const j = json as Row;
  const found = Array.isArray(j[key]) ? j[key] : undefined;
  // An empty list can come back with its key left out entirely.
  if (!found) return [];
  return (found as unknown[]).filter(
    (r): r is Row => !!r && typeof r === 'object' && !Array.isArray(r),
  );
}

/** total_count from any of Ituran's paging envelopes. */
export function totalOf(json: unknown): number | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const j = json as Row;
  const meta = j.metadata as Row | undefined;
  const block = (meta?.pagination ??
    (j.meta as Row | undefined)?.pagination ??
    j.pagination ??
    meta) as Row | undefined;
  const total = block?.total_count;
  return typeof total === 'number' ? total : null;
}

export interface Page {
  rows: Row[];
  total: number | null;
}

export type FetchPage = (pageNumber: number, pageSize: number) => Promise<Page>;

/** Ituran's page sizes run from 10 to 2,000. */
export const MIN_PAGE = 10;
export const MAX_PAGE = 2000;

/** Rows [offset, offset + limit) for any limit, over Ituran's page sizes. */
export async function windowRows(
  fetchPage: FetchPage,
  page: number,
  limit: number,
): Promise<Page> {
  if (limit >= MIN_PAGE) return fetchPage(page, limit);
  const offset = (page - 1) * limit;
  const first = Math.floor(offset / MIN_PAGE) + 1;
  const a = await fetchPage(first, MIN_PAGE);
  let rows = a.rows.slice(offset % MIN_PAGE);
  if (rows.length < limit && a.rows.length === MIN_PAGE) {
    rows = rows.concat((await fetchPage(first + 1, MIN_PAGE)).rows);
  }
  return { rows: rows.slice(0, limit), total: a.total };
}

/** A list's row count: the declared total, or the rows of a page that was not full. */
function countOf(got: Page, pageSize: number): number {
  if (got.total !== null) return got.total;
  if (got.rows.length < pageSize) return got.rows.length;
  throw new AxiError(
    'ituran_error',
    'Ituran sent a page without a row count. Ask for a shorter window.',
  );
}

/**
 * Rows [offset, offset + limit) of several lists read as one, in order. The
 * first page of each list gives its count; then only the pages that hold the
 * wanted rows are read. The first list's first page is read at full size,
 * since the wanted rows are usually there.
 */
export async function joinedRows(
  lists: FetchPage[],
  page: number,
  limit: number,
): Promise<Page> {
  const [only] = lists;
  if (lists.length === 1 && only) return windowRows(only, page, limit);
  const size = Math.max(limit, MIN_PAGE);
  const offset = (page - 1) * limit;
  const firstSize = (i: number) => (i === 0 && offset < size ? size : MIN_PAGE);
  const firsts = await Promise.all(
    lists.map((fetchPage, i) => fetchPage(1, firstSize(i))),
  );
  const counts = firsts.map((got, i) => countOf(got, firstSize(i)));
  const starts = counts.map((_, i) =>
    counts.slice(0, i).reduce((a, b) => a + b, 0),
  );
  const parts = await Promise.all(
    lists.map(async (fetchPage, i) => {
      const from = Math.max(offset - (starts[i] as number), 0);
      const to = Math.min(
        offset + limit - (starts[i] as number),
        counts[i] as number,
      );
      if (from >= to) return [];
      const first = firsts[i] as Page;
      if (to <= first.rows.length) return first.rows.slice(from, to);
      const firstPage = Math.floor(from / size) + 1;
      const rows: Row[] = [];
      for (let p = firstPage; (p - 1) * size < to; p++)
        rows.push(...(await fetchPage(p, size)).rows);
      const base = (firstPage - 1) * size;
      return rows.slice(from - base, to - base);
    }),
  );
  return {
    rows: parts.flat().slice(0, limit),
    total: counts.reduce((a, b) => a + b, 0),
  };
}

export interface Walk extends Page {
  /** Why the walk stopped before the declared total, when it did. */
  partial?: string;
}

/** Every row, page by page, up to `cap` rows; stops early and says so when time runs out. */
export async function walkAll(
  fetchPage: FetchPage,
  pageSize: number,
  cap = 20_000,
): Promise<Walk> {
  const rows: Row[] = [];
  let total: number | null = null;
  for (let page = 1; ; page++) {
    let got: Page;
    try {
      got = await fetchPage(page, pageSize);
    } catch (error) {
      if (
        page > 1 &&
        error instanceof AxiError &&
        error.code === 'unreachable'
      ) {
        return {
          rows,
          total,
          partial: `stopped after ${rows.length} rows: ${error.message}`,
        };
      }
      throw error;
    }
    total ??= got.total;
    rows.push(...got.rows);
    if (got.rows.length < pageSize || (total !== null && rows.length >= total))
      return { rows, total };
    if (rows.length >= cap)
      return { rows, total, partial: `stopped at ${cap} rows` };
  }
}

/**
 * Every row of one list: its first page gives the total, then the other
 * pages are read side by side. Without a total it walks page by page.
 */
export async function everyRow(
  fetchPage: FetchPage,
  size: number,
  cap: number,
): Promise<Walk> {
  const first = await fetchPage(1, size);
  if (first.total === null || first.rows.length < size)
    return first.total === null && first.rows.length === size
      ? walkAll(fetchPage, size, cap)
      : first;
  const wanted = Math.min(first.total, cap);
  const pages = Math.ceil(wanted / size);
  const rest = await Promise.all(
    Array.from({ length: pages - 1 }, (_, i) => fetchPage(i + 2, size)),
  );
  const rows = [first, ...rest].flatMap((page) => page.rows);
  return first.total > cap
    ? { rows, total: first.total, partial: `stopped at ${cap} rows` }
    : { rows, total: first.total };
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "20 of 164 vehicles", or "3 vehicles" when every row is shown. */
export function countLine(
  shown: number,
  total: number | null,
  noun: string,
  nouns = `${noun}s`,
): string {
  if (total === null) return plural(shown, noun, nouns);
  if (total === shown) return plural(total, noun, nouns);
  return `${shown} of ${total} ${total === 1 ? noun : nouns}`;
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === '';

/** A table row: exactly `columns`, empty values as null, so TOON keeps the tabular form. */
export function tableRow(
  row: Row,
  columns: readonly string[],
  fieldLimit: number,
): Row {
  const out: Row = {};
  for (const name of columns) {
    const v = row[name];
    out[name] = isEmpty(v)
      ? null
      : typeof v === 'string' && Number.isFinite(fieldLimit)
        ? cut(v, fieldLimit)
        : v;
  }
  return out;
}

/** Drop empty values and cut long strings, recursively, for a record view. */
export function compact(value: unknown, fieldLimit: number): unknown {
  if (typeof value === 'string')
    return Number.isFinite(fieldLimit) ? cut(value, fieldLimit) : value;
  if (Array.isArray(value)) return value.map((v) => compact(v, fieldLimit));
  if (value && typeof value === 'object') {
    const out: Row = {};
    for (const [k, v] of Object.entries(value)) {
      if (isEmpty(v)) continue;
      if (
        v &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        Object.keys(v).length === 0
      )
        continue;
      out[k] = compact(v, fieldLimit);
    }
    return out;
  }
  return value;
}

/** Check --fields against the columns a list can show. */
export function columnsFlag(
  v: unknown,
  fallback: readonly string[],
  known: readonly string[],
): string[] {
  if (typeof v !== 'string') return [...fallback];
  const asked = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = asked.filter((c) => !known.includes(c));
  if (!asked.length || unknown.length) {
    throw usage(`--fields takes names from: ${known.join(', ')}.`);
  }
  return [...new Set(asked)];
}

export interface ListView {
  key: string;
  summary: string;
  head?: Row;
  rows: Row[];
  columns: readonly string[];
  help: readonly string[];
  full: boolean;
  /** A narrower command, named when even --full is too large. */
  narrower: string;
}

/** A list bounded to the default output size: long fields are cut, then rows are dropped and counted. */
export function listOutput(view: ListView): string {
  return bounded(
    {
      total: view.rows.length,
      narrower: view.narrower,
      build: (shown, fieldLimit) => {
        const dropped = view.rows.length - shown;
        const doc: Row = {
          summary: dropped
            ? `${view.summary}; the last ${dropped} left out to fit, use --limit or --full`
            : view.summary,
          ...(view.head ?? {}),
        };
        doc[view.key] = view.rows
          .slice(0, shown)
          .map((r) => tableRow(r, view.columns, fieldLimit));
        return render(doc, view.help);
      },
    },
    view.full,
  );
}

/** A single record: empty values dropped, long text cut unless --full. */
export function recordOutput(
  doc: Row,
  full: boolean,
  narrower: string,
  help: readonly string[] = [],
): string {
  return bounded(
    {
      total: 1,
      narrower,
      build: (_shown, fieldLimit) =>
        render(compact(doc, fieldLimit) as Row, help),
    },
    full,
  );
}

export function binPath(argv1: string | undefined): string {
  const home = homedir();
  const path = argv1 ?? 'ituran-axi';
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export function environmentOf(url: string): string {
  const host = new URL(url).hostname;
  if (host === 'api.ituran.com') return 'production';
  if (host.startsWith('api-qa.')) return 'QA';
  if (host.startsWith('testapi.')) return 'test';
  return 'other';
}
