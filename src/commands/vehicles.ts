// vehicles, vehicle and where. One read with Ituran's realtime blocks gives a
// vehicle's last position (with its address), its current driver and the
// saved places it is in, so a vehicle and the positions of every vehicle each
// take one or two requests.

import type { CommandInput } from '../cli/table.ts';
import { AxiError } from '../errors.ts';
import { normalizePlate } from '../plates.ts';
import { age, ageMinutes, parseSpan } from '../time.ts';
import {
  account,
  api,
  type Ctx,
  columnsFlag,
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
  strings,
  totalOf,
  walkAll,
  windowRows,
} from './common.ts';

const REALTIME = ['LastLocation', 'Driver', 'Places'];
const WALK_PAGE = 500;

const obj = (v: unknown): Row =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {};

/** "Toyota Corolla 2022"; a model year of 0 means unset. */
function modelOf(v: Row): string | null {
  const year = v.model_year;
  const parts = [
    str(v.make_name),
    str(v.model_name),
    year && year !== '0' && year !== 0 ? String(year) : undefined,
  ];
  const text = parts.filter((p) => p?.trim()).join(' ');
  return text || null;
}

function driverName(d: Row): string | null {
  const name = [str(d.first_name), str(d.last_name)]
    .filter((p) => p?.trim())
    .join(' ');
  return name || null;
}

/** One vehicle as the flat row every list and view is cut from. */
export function vehicleRow(v: Row, now: Date, zone: string): Row {
  const loc = obj(v.last_location ?? v.location);
  const place = obj(loc.location);
  const point = obj(place.point ?? loc.point);
  const address = place.address;
  const driver = obj(v.current_driver);
  const places = Array.isArray(v.places)
    ? (v.places as unknown[]).map((p) => str(obj(p).place_name)).filter(Boolean)
    : [];
  const odometer =
    typeof loc.odometer === 'number' && loc.odometer > 0 ? loc.odometer : null;
  return {
    plate: str(v.license_plate) ?? null,
    name: str(v.nickname) ?? null,
    model: modelOf(v),
    status: str(v.motion_status) ?? null,
    color: str(v.color) ?? null,
    age: age(loc.timestamp, now, zone),
    time: str(loc.timestamp) ?? null,
    speed: typeof loc.speed === 'number' ? loc.speed : null,
    limit:
      typeof obj(address).speedlimit === 'number'
        ? obj(address).speedlimit
        : null,
    lat: typeof point.lat === 'number' ? point.lat : null,
    lon: typeof point.lon === 'number' ? point.lon : null,
    address:
      typeof address === 'string'
        ? address
        : (str(obj(address).location) ?? null),
    odometer,
    driver: driverName(driver),
    places: places.length ? places.join('; ') : null,
  };
}

const LIST_COLUMNS = ['plate', 'name', 'model', 'status'];
const WHERE_COLUMNS = ['plate', 'age', 'status', 'speed', 'address'];
const KNOWN = [
  'plate',
  'name',
  'model',
  'status',
  'color',
  'age',
  'time',
  'speed',
  'limit',
  'lat',
  'lon',
  'address',
  'odometer',
  'driver',
  'places',
];

function listPage(ctx: Ctx, realtime: readonly string[] = []): FetchPage {
  return async (page_number, page_size) => {
    const json = await ctx.client.read({
      method: 'GET',
      path: api(ctx, '/vehicles'),
      query: {
        page_number,
        page_size,
        ...(realtime.length ? { realtime_fields: realtime } : {}),
      },
      ctx: { what: 'vehicles' },
      emptyOn404: true,
    });
    return {
      rows: rowsOf(json, 'vehicles'),
      total: totalOf(json) ?? (json === null ? 0 : null),
    };
  };
}

function searchPage(
  ctx: Ctx,
  body: Row,
  realtime: readonly string[] = [],
): FetchPage {
  return async (page_number, page_size) => {
    // No match comes back as 404 404.3, which means an empty list.
    const json = await ctx.client.read({
      method: 'POST',
      path: api(ctx, '/vehicles/search'),
      body,
      query: {
        page_number,
        page_size,
        ...(realtime.length ? { realtime_fields: realtime } : {}),
      },
      ctx: { what: 'matching vehicles' },
      emptyOn404: true,
    });
    return {
      rows: rowsOf(json, 'vehicles'),
      total: json === null ? 0 : totalOf(json),
    };
  };
}

export async function vehicles(input: CommandInput): Promise<string> {
  const ctx = open(input);
  const { values, positionals } = input;
  const limit = intFlag(values.limit, 'limit', 20, 1, MAX_PAGE);
  const page = intFlag(values.page, 'page', 1, 1, 100_000);
  const columns = columnsFlag(values.fields, LIST_COLUMNS, KNOWN);
  const text = positionals.join(' ').trim();
  const needsRealtime = columns.some(
    (c) => !LIST_COLUMNS.includes(c) && c !== 'color',
  );
  const realtime = needsRealtime ? REALTIME : [];
  const acc = needsRealtime ? await account(ctx) : null;
  const zone = acc?.zone ?? 'UTC';
  let got: { rows: Row[]; total: number | null };
  let how = '';
  if (!text) {
    got = await windowRows(listPage(ctx, realtime), page, limit);
  } else if (/^[\d\s-]+$/.test(text)) {
    const part = text.replace(/[\s-]+/g, '');
    got = await windowRows(
      searchPage(ctx, { wildcard_filter: { license_plate: part } }, realtime),
      page,
      limit,
    );
    how = ` with ${part} in the plate`;
  } else {
    got = await windowRows(
      searchPage(ctx, { wildcard_filter: { nickname: text } }, realtime),
      page,
      limit,
    );
    how = ` named like "${text}"`;
    if (got.total === 0 && page === 1) {
      // Ituran searches names only; make, model and color are matched here.
      const all = await walkAll(listPage(ctx, realtime), WALK_PAGE);
      const needle = text.toLowerCase();
      const hits = all.rows.filter((v) =>
        [v.make_name, v.model_name, v.color, v.model_year].some(
          (f) => typeof f === 'string' && f.toLowerCase().includes(needle),
        ),
      );
      got = { rows: hits.slice(0, limit), total: hits.length };
      how = ` matching "${text}" by make, model or color`;
    }
  }
  const rows = got.rows.map((v) => vehicleRow(v, ctx.now, zone));
  const total = got.total;
  const shownTo = (page - 1) * limit + rows.length;
  const more = total !== null && shownTo < total;
  const words = text ? [shellWord(text)] : [];
  const help: string[] = [];
  if (more)
    help.push(
      `Run \`ituran-axi vehicles ${[...words, '--page', String(page + 1), ...(limit !== 20 ? ['--limit', String(limit)] : [])].join(' ')}\` for the next ${Math.min(limit, total - shownTo)}`,
    );
  if (rows.length)
    help.push(
      'Run `ituran-axi vehicle <plate>` for one vehicle with its position and driver',
    );
  if (!text && rows.length)
    help.push("Run `ituran-axi where --all` for every vehicle's last position");
  const summary = rows.length
    ? `${countLine(rows.length, total, 'vehicle')}${how}${page > 1 ? `, page ${page}` : ''}`
    : `0 vehicles${how}`;
  return listOutput({
    key: 'vehicles',
    summary,
    rows,
    columns,
    help: help.slice(0, 3),
    full: values.full === true,
    narrower: 'ituran-axi vehicles --limit <n>',
  });
}

export async function vehicle(input: CommandInput): Promise<string> {
  const ctx = open(input);
  const plate = normalizePlate(input.positionals[0] as string);
  const acc = await account(ctx);
  const full = input.values.full === true;
  const v = (await ctx.client.read({
    method: 'GET',
    path: api(ctx, `/vehicles/${plate}`),
    query: { realtime_fields: REALTIME },
    ctx: { what: `vehicle ${plate}`, plate },
  })) as Row | null;
  if (!v || typeof v !== 'object')
    throw new AxiError('ituran_error', 'Ituran sent no vehicle.');
  const r = vehicleRow(v, ctx.now, acc.zone);
  const driver = obj(v.current_driver);
  const places = Array.isArray(v.places)
    ? (v.places as unknown[]).map((p) => obj(p))
    : [];
  const doc: Row = {
    plate: r.plate,
    name: r.name,
    model: r.model,
    color: r.color,
    status: r.status,
    position: r.time
      ? {
          time: r.time,
          age: r.age,
          speed: r.speed,
          speed_limit: r.limit,
          address: r.address,
          lat: r.lat,
          lon: r.lon,
          odometer_km: r.odometer,
        }
      : 'no position reported',
    driver: Object.keys(driver).length
      ? {
          name: driverName(driver),
          id: driver.driver_id,
          ...(full ? { phone: driver.phone, cellular: driver.cellular } : {}),
        }
      : 'none assigned now',
    places: places.length
      ? places.map((p) => str(p.place_name) ?? String(p.place_id ?? ''))
      : 'in no saved place',
    ...(full
      ? {
          vin: v.vin,
          vehicle_id: v.vehicle_id,
          model_year: v.model_year,
          telematics_units: Array.isArray(v.telematics_units)
            ? v.telematics_units.length
            : undefined,
        }
      : {}),
    zone: acc.zone,
  };
  return recordOutput(doc, full, `ituran-axi vehicle ${plate}`);
}

export async function where(input: CommandInput): Promise<string> {
  const ctx = open(input);
  const { values } = input;
  const plates = input.positionals.map(normalizePlate);
  if (plates.length && values.all === true)
    throw new AxiError('usage', 'Give plates or --all, not both.');
  const acc = await account(ctx);
  const limit = intFlag(values.limit, 'limit', 20, 1, MAX_PAGE);
  const page = intFlag(values.page, 'page', 1, 1, 100_000);
  const columns = columnsFlag(values.fields, WHERE_COLUMNS, KNOWN);
  const staleMin =
    typeof values.stale === 'string' ? parseSpan(values.stale, 'stale') : null;
  let raw: Row[];
  let partial: string | undefined;
  let missing: string[] = [];
  if (plates.length) {
    const unique = [...new Set(plates)];
    const got = await searchPage(ctx, { license_plates: unique }, [
      'LastLocation',
    ])(1, Math.max(10, unique.length));
    raw = got.rows;
    const found = new Set(raw.map((v) => str(v.license_plate)));
    missing = unique.filter((p) => !found.has(p));
  } else {
    const all = await walkAll(listPage(ctx, ['LastLocation']), WALK_PAGE);
    raw = all.rows;
    partial = all.partial;
  }
  const rows = raw.map((v) => vehicleRow(v, ctx.now, acc.zone));
  const threshold = staleMin ?? 24 * 60;
  const staleOf = (r: Row) => {
    const m = ageMinutes(r.time, ctx.now, acc.zone);
    return m === null || m > threshold;
  };
  const byStatus = new Map<string, number>();
  for (const r of rows) {
    const s = typeof r.status === 'string' && r.status ? r.status : 'unknown';
    byStatus.set(s, (byStatus.get(s) ?? 0) + 1);
  }
  const noPosition = rows.filter((r) => !r.time).length;
  const stale = rows.filter((r) => r.time && staleOf(r)).length;
  const span = typeof values.stale === 'string' ? values.stale : '24h';
  const parts = [
    `${rows.length} ${rows.length === 1 ? 'vehicle' : 'vehicles'}`,
    ...[...byStatus.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([s, n]) => `${n} ${s}`),
    `${stale} last seen over ${span} ago`,
    ...(noPosition ? [`${noPosition} with no position`] : []),
  ];
  const selected = staleMin !== null ? rows.filter(staleOf) : rows;
  const offset = (page - 1) * limit;
  const shown = selected.slice(offset, offset + limit);
  const help: string[] = [];
  if (offset + shown.length < selected.length) {
    const args = plates.length ? plates : ['--all'];
    help.push(
      `Run \`ituran-axi where ${[...args, ...(staleMin !== null ? ['--stale', span] : []), '--page', String(page + 1), ...(limit !== 20 ? ['--limit', String(limit)] : [])].join(' ')}\` for the next ${Math.min(limit, selected.length - offset - shown.length)}`,
    );
  }
  if (shown.length)
    help.push(
      "Run `ituran-axi vehicle <plate>` for one vehicle's driver and saved places",
    );
  if (shown.length)
    help.push('Run `ituran-axi trips <plate> --since 24h` for where it went');
  const listed =
    staleMin !== null ? `${selected.length} last seen over ${span} ago` : null;
  return listOutput({
    key: 'vehicles',
    summary: parts.join(' · '),
    head: {
      ...(listed ? { listed } : {}),
      ...(missing.length ? { not_found: missing.join(' ') } : {}),
      ...(partial ? { partial } : {}),
      zone: acc.zone,
    },
    rows: shown,
    columns,
    help: help.slice(0, 3),
    full: values.full === true,
    narrower: 'ituran-axi where <plate>...',
  });
}

export const plateArgs = (input: CommandInput): string[] =>
  strings(input.positionals).map(normalizePlate);
