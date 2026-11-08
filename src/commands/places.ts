// places and place. Saved places carry their polygons, so a name search runs
// over a small local index of names, rebuilt after a day. Which vehicles are in
// a place comes from each vehicle's own list of saved places, one or two reads,
// because Ituran's per-place route can take over a minute.

import { join } from 'node:path';
import { readJson, writeJson } from '../account.ts';
import type { CommandInput } from '../cli/table.ts';
import { AxiError, usage } from '../errors.ts';
import {
  account,
  api,
  type Ctx,
  countLine,
  type FetchPage,
  intFlag,
  listOutput,
  MAX_PAGE,
  open,
  type Row,
  recordOutput,
  rowsOf,
  shellWord,
  str,
  totalOf,
  walkAll,
  windowRows,
} from './common.ts';
import { vehicleRow } from './vehicles.ts';

const INDEX_MAX_AGE_MS = 24 * 3600_000;
const INDEX_PAGE = 500;

interface PlaceIndex {
  builtAt: string;
  places: Row[];
}

function placeRow(p: Row): Row {
  const point = (p.point && typeof p.point === 'object' ? p.point : {}) as Row;
  return {
    id: p.place_id ?? p.id ?? null,
    name: str(p.name) ?? str(p.place_name) ?? null,
    type: str(p.place_type) ?? null,
    description: str(p.description) ?? null,
    lat: typeof point.lat === 'number' ? point.lat : null,
    lon: typeof point.lon === 'number' ? point.lon : null,
    radius_m: typeof p.radius === 'number' ? p.radius : null,
    layer: p.layer_id ?? null,
  };
}

const placesPage =
  (ctx: Ctx): FetchPage =>
  async (page_number, page_size) => {
    const json = await ctx.client.read({
      method: 'GET',
      path: api(ctx, '/places'),
      query: { page_number, page_size },
      ctx: { what: 'saved places' },
      emptyOn404: true,
    });
    return {
      rows: rowsOf(json, 'places'),
      total: json === null ? 0 : totalOf(json),
    };
  };

async function placeIndex(
  ctx: Ctx,
  refresh: boolean,
): Promise<PlaceIndex & { built: boolean }> {
  const file = join(ctx.dir, 'places.json');
  const cached = readJson<PlaceIndex>(file);
  if (
    !refresh &&
    cached &&
    ctx.now.getTime() - Date.parse(cached.builtAt) < INDEX_MAX_AGE_MS &&
    Array.isArray(cached.places)
  ) {
    return { ...cached, built: false };
  }
  const all = await walkAll(placesPage(ctx), INDEX_PAGE);
  if (all.partial)
    throw new AxiError(
      'unreachable',
      `Ituran's place list could not be read in time (${all.partial}). Run it again.`,
    );
  const index = {
    builtAt: ctx.now.toISOString(),
    places: all.rows.map(placeRow),
  };
  writeJson(ctx.dir, 'places.json', index);
  return { ...index, built: true };
}

const fold = (s: string) =>
  s
    .toLowerCase()
    .replace(/ך/g, 'כ')
    .replace(/ם/g, 'מ')
    .replace(/ן/g, 'נ')
    .replace(/ף/g, 'פ')
    .replace(/ץ/g, 'צ');

export async function places(input: CommandInput): Promise<string> {
  const ctx = open(input);
  const { values } = input;
  const limit = intFlag(values.limit, 'limit', 20, 1, MAX_PAGE);
  const page = intFlag(values.page, 'page', 1, 1, 100_000);
  const text = input.positionals.join(' ').trim();
  let rows: Row[];
  let total: number | null;
  let head: Row = {};
  if (text) {
    const index = await placeIndex(ctx, values.refresh === true);
    const needle = fold(text);
    const hits = index.places.filter((p) =>
      [p.name, p.description].some(
        (v) => typeof v === 'string' && fold(v).includes(needle),
      ),
    );
    total = hits.length;
    rows = hits.slice((page - 1) * limit, page * limit);
    head = {
      index: index.built
        ? `built now: ${index.places.length} places`
        : `${index.places.length} places, built ${index.builtAt.slice(0, 10)}`,
    };
  } else {
    const got = await windowRows(placesPage(ctx), page, limit);
    rows = got.rows.map(placeRow);
    total = got.total;
  }
  const shownTo = (page - 1) * limit + rows.length;
  const help: string[] = [];
  if (total !== null && shownTo < total) {
    help.push(
      `Run \`ituran-axi places ${[...(text ? [shellWord(text)] : []), '--page', String(page + 1), ...(limit !== 20 ? ['--limit', String(limit)] : [])].join(' ')}\` for the next ${Math.min(limit, total - shownTo)}`,
    );
  }
  if (rows.length)
    help.push(
      'Run `ituran-axi place <id> --vehicles` for the vehicles in a place now',
    );
  return listOutput({
    key: 'places',
    summary: rows.length
      ? `${countLine(rows.length, total, 'saved place')}${text ? ` matching "${text}"` : ''}`
      : `0 saved places${text ? ` match "${text}"` : ''}`,
    head,
    rows,
    columns: ['id', 'name', 'type', 'description'],
    help,
    full: values.full === true,
    narrower: 'ituran-axi places <text>',
  });
}

export async function place(input: CommandInput): Promise<string> {
  const ctx = open(input);
  const id = input.positionals[0] as string;
  if (!/^\d{1,20}$/.test(id))
    throw usage('A place id is a number, as `ituran-axi places` lists it.');
  const index = await placeIndex(ctx, input.values.refresh === true);
  const found = index.places.find((p) => String(p.id) === id);
  if (!found) {
    throw new AxiError(
      'not_found',
      `This account has no saved place ${id}. Find it with \`ituran-axi places <text>\`.`,
    );
  }
  const doc: Row = { ...found };
  if (input.values.vehicles === true) {
    const acc = await account(ctx);
    const all = await walkAll(async (page_number, page_size) => {
      const json = await ctx.client.read({
        method: 'GET',
        path: api(ctx, '/vehicles'),
        query: {
          page_number,
          page_size,
          realtime_fields: ['LastLocation', 'Places'],
        },
        ctx: { what: 'vehicles' },
        emptyOn404: true,
      });
      return {
        rows: rowsOf(json, 'vehicles'),
        total: json === null ? 0 : totalOf(json),
      };
    }, INDEX_PAGE);
    const inside = all.rows.filter(
      (v) =>
        Array.isArray(v.places) &&
        (v.places as Row[]).some((p) => String(p?.place_id) === id),
    );
    doc.vehicles_summary = `${inside.length} of ${all.rows.length} vehicles are in this place now`;
    if (all.partial) doc.partial = all.partial;
    doc.vehicles = inside.map((v) => {
      const r = vehicleRow(v, ctx.now, acc.zone);
      return { plate: r.plate, name: r.name, status: r.status, age: r.age };
    });
  }
  return recordOutput(
    doc,
    input.values.full === true,
    `ituran-axi place ${id}`,
  );
}
