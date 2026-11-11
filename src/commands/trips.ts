// trips, trip and totals. Ituran matches a trip to a window by its end time,
// and lists a trip only some hours after it ends; the output says so when it
// matters. Totals for the whole account take dates, not times.

import type { Account } from '../account.ts';
import type { CommandInput } from '../cli/table.ts';
import { AxiError, usage } from '../errors.ts';
import { normalizePlate } from '../plates.ts';
import {
  hoursMinutes,
  localTime,
  naiveMs,
  splitWindow,
  type Window,
  windowOf,
} from '../time.ts';
import {
  account,
  api,
  type Ctx,
  columnsFlag,
  countLine,
  everyRow,
  type FetchPage,
  intFlag,
  joinedRows,
  listOutput,
  MAX_PAGE,
  open,
  type Row,
  recordOutput,
  rowsOf,
  str,
  totalOf,
  walkAll,
} from './common.ts';
import { listPage, WALK_PAGE } from './vehicles.ts';

const obj = (v: unknown): Row =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {};
const round1 = (v: unknown) =>
  typeof v === 'number' ? Math.round(v * 10) / 10 : null;
const RECENT_HOURS = 6;
/** Ituran fails an account-wide month of trips with HTTP 500, but answers a week. */
export const TRIP_SPAN_DAYS = 7;
const LATE_NOTE =
  'Ituran matches trips by their end time and lists a trip up to a few hours after it ends.';

function windowFlags(values: CommandInput['values']) {
  return {
    since: str(values.since),
    from: str(values.from),
    to: str(values.to),
    date: str(values.date),
  };
}

function addressOf(end: Row): string | null {
  const address = obj(obj(end.location).address);
  return str(address.location) ?? null;
}

/** A trip end's coordinate; (0,0) is Ituran's "no fix", so it is no coordinate. */
function coordinate(end: Row, key: 'lat' | 'lon'): number | null {
  const point = obj(obj(end.location).point);
  if (point.lat === 0 && point.lon === 0) return null;
  return typeof point[key] === 'number' ? (point[key] as number) : null;
}

function driverOf(t: Row): string | null {
  const name = str(t.driver_name);
  if (name?.trim()) return name;
  const code = t.driver_code;
  return code !== undefined && code !== null && code !== 0 && code !== -1
    ? `code ${String(code)}`
    : null;
}

export function tripRow(t: Row): Row {
  const start = obj(t.start_location);
  const end = obj(t.end_location);
  const safety = obj(t.safety);
  return {
    id: t.trip_id ?? null,
    plate: str(t.license_plate) ?? null,
    start: str(start.timestamp) ?? null,
    end: str(end.timestamp) ?? null,
    km: round1(t.distance),
    driver: driverOf(t),
    duration: hoursMinutes(t.duration_in_seconds),
    idle: hoursMinutes(t.idle_duration_in_minutes, 'minutes'),
    max_speed: typeof t.max_speed === 'number' ? t.max_speed : null,
    safety:
      typeof safety.safety_grade === 'number' ? safety.safety_grade : null,
    events:
      typeof safety.safety_events_count === 'number'
        ? safety.safety_events_count
        : null,
    from: addressOf(start),
    to: addressOf(end),
    start_lat: coordinate(start, 'lat'),
    start_lon: coordinate(start, 'lon'),
    end_lat: coordinate(end, 'lat'),
    end_lon: coordinate(end, 'lon'),
    status: str(t.trip_status) ?? null,
  };
}

const KNOWN = [
  'id',
  'plate',
  'start',
  'end',
  'km',
  'driver',
  'duration',
  'idle',
  'max_speed',
  'safety',
  'events',
  'from',
  'to',
  'status',
  'start_lat',
  'start_lon',
  'end_lat',
  'end_lon',
];

/** One week's trips, page by page, for the plates given or the whole account. */
function tripPages(ctx: Ctx, plates: string[], span: Window): FetchPage {
  const one = plates.length === 1 ? plates[0] : undefined;
  return async (page_number, page_size) => {
    const json = await ctx.client.read({
      method: 'GET',
      path: api(ctx, '/trips'),
      query: {
        ...(plates.length ? { license_plates: plates } : {}),
        from_date: span.from,
        to_date: span.to,
        page_number,
        page_size,
      },
      ctx: { what: 'trips', trips: true, ...(one ? { plate: one } : {}) },
      emptyOn404: true,
    });
    return {
      rows: rowsOf(json, 'trips'),
      total: json === null ? 0 : totalOf(json),
    };
  };
}

export async function trips(input: CommandInput): Promise<string> {
  const ctx = open(input);
  const { values } = input;
  const plates = [...new Set(input.positionals.map(normalizePlate))];
  const acc = await account(ctx);
  const w = windowOf(windowFlags(values), acc.zone, ctx.now, '24h');
  const by = str(values.by);
  if (by !== undefined) {
    if (by !== 'plate')
      throw usage('--by takes plate: one row per vehicle over the window.');
    return tripsByPlate(input, ctx, acc, w, plates);
  }
  const limit = intFlag(values.limit, 'limit', 20, 1, MAX_PAGE);
  const page = intFlag(values.page, 'page', 1, 1, 100_000);
  const one = plates.length === 1 ? plates[0] : undefined;
  const columns = columnsFlag(
    values.fields,
    one
      ? ['id', 'start', 'end', 'km', 'driver']
      : ['id', 'plate', 'start', 'km', 'driver'],
    KNOWN,
  );
  // Long windows are read a week at a time, newest first, as one list.
  const lists = splitWindow(w, TRIP_SPAN_DAYS).map((span) =>
    tripPages(ctx, plates, span),
  );
  const got = await joinedRows(lists, page, limit);
  const rows = got.rows.map(tripRow);
  const total = got.total;
  const whose = plates.length ? `for ${plates.join(' ')}` : 'for all vehicles';
  const nowLocal = naiveMs(localTime(ctx.now, acc.zone)) as number;
  const recent = nowLocal - (naiveMs(w.to) as number) < RECENT_HOURS * 3600_000;
  const allShown = total !== null && rows.length === total;
  const km = allShown
    ? Math.round(
        rows.reduce((s, r) => s + (typeof r.km === 'number' ? r.km : 0), 0) *
          10,
      ) / 10
    : null;
  const summary = `${rows.length ? countLine(rows.length, total, 'trip') : '0 trips'} ${whose}${km !== null && rows.length ? ` · ${km} km` : ''}`;
  const shownTo = (page - 1) * limit + rows.length;
  const help: string[] = [];
  if (total !== null && shownTo < total) {
    const args = [
      ...plates,
      ...flagWords(values),
      '--page',
      String(page + 1),
      ...(limit !== 20 ? ['--limit', String(limit)] : []),
    ];
    help.push(
      `Run \`ituran-axi trips ${args.join(' ')}\` for the next ${Math.min(limit, total - shownTo)}`,
    );
  }
  if (rows.length)
    help.push(
      "Run `ituran-axi trip <id>` for a trip's addresses, duration and speed",
    );
  if (rows.length)
    help.push(
      `Run \`${['ituran-axi totals', ...(one ? [one] : []), ...flagWords(values)].join(' ')}\` for the totals of this window`,
    );
  return listOutput({
    key: 'trips',
    summary,
    head: {
      window: `${w.from} to ${w.to}`,
      zone: acc.zone,
      ...(recent || !rows.length ? { note: LATE_NOTE } : {}),
    },
    rows,
    columns,
    help: help.slice(0, 3),
    full: values.full === true,
    narrower: 'ituran-axi trips <plate> --since 24h',
  });
}

const BY_KNOWN = [
  'plate',
  'trips',
  'km',
  'km_per_day',
  'max_speed',
  'driving',
  'days',
];
/** Trips read per week of a --by plate window before the totals say partial. */
const BY_CAP = 50_000;

interface Tally {
  trips: number;
  km: number;
  max: number | null;
  seconds: number;
  days: Set<string>;
}

/**
 * One row per vehicle over the window: its trips, km, km a day (km over the
 * window's days), top speed, driving time and days with a trip. Every trip of
 * the window is read, a week at a time; with no plates, every vehicle of the
 * account has a row, those that did not drive included.
 */
async function tripsByPlate(
  input: CommandInput,
  ctx: Ctx,
  acc: Account,
  w: Window,
  plates: string[],
): Promise<string> {
  const { values } = input;
  const limit = intFlag(values.limit, 'limit', 20, 1, MAX_PAGE);
  const page = intFlag(values.page, 'page', 1, 1, 100_000);
  const columns = columnsFlag(
    values.fields,
    ['plate', 'trips', 'km', 'km_per_day', 'max_speed'],
    BY_KNOWN,
  );
  const [walks, fleet] = await Promise.all([
    Promise.all(
      splitWindow(w, TRIP_SPAN_DAYS).map((span) =>
        everyRow(tripPages(ctx, plates, span), MAX_PAGE, BY_CAP),
      ),
    ),
    plates.length
      ? Promise.resolve(plates)
      : walkAll(listPage(ctx), WALK_PAGE).then((all) =>
          all.rows
            .map((v) => str(v.license_plate))
            .filter((p) => p !== undefined),
        ),
  ]);
  const key = (plate: string) => plate.replace(/[\s-]+/g, '').toUpperCase();
  const tally = new Map<string, Tally & { plate: string }>();
  const fresh = (plate: string) => ({
    plate,
    trips: 0,
    km: 0,
    max: null,
    seconds: 0,
    days: new Set<string>(),
  });
  for (const plate of fleet)
    if (!tally.has(key(plate))) tally.set(key(plate), fresh(plate));
  // A trip on a week's or a page's edge can come twice; it counts once.
  const seen = new Set<unknown>();
  let tripCount = 0;
  for (const t of walks.flatMap((walk) => walk.rows)) {
    const plate = str(t.license_plate);
    if (!plate) continue;
    if (t.trip_id !== undefined && t.trip_id !== null) {
      if (seen.has(t.trip_id)) continue;
      seen.add(t.trip_id);
    }
    tripCount++;
    const a = tally.get(key(plate)) ?? fresh(plate);
    a.trips++;
    if (typeof t.distance === 'number' && t.distance > 0) a.km += t.distance;
    if (typeof t.max_speed === 'number')
      a.max = a.max === null ? t.max_speed : Math.max(a.max, t.max_speed);
    if (typeof t.duration_in_seconds === 'number')
      a.seconds += t.duration_in_seconds;
    const day = (
      str(obj(t.start_location).timestamp) ?? str(obj(t.end_location).timestamp)
    )?.slice(0, 10);
    if (day) a.days.add(day);
    tally.set(key(plate), a);
  }
  const days =
    ((naiveMs(w.to) as number) - (naiveMs(w.from) as number) + 1000) /
    86_400_000;
  const all = [...tally.values()]
    .map(
      (a): Row => ({
        plate: a.plate,
        trips: a.trips,
        km: round1(a.km),
        km_per_day: days > 0 ? round1(a.km / days) : null,
        max_speed: a.max,
        driving: hoursMinutes(a.seconds),
        days: a.days.size,
      }),
    )
    .sort(
      (x, y) =>
        (y.km as number) - (x.km as number) ||
        String(x.plate).localeCompare(String(y.plate)),
    );
  const rows = all.slice((page - 1) * limit, page * limit);
  const partial = walks.map((walk) => walk.partial).find(Boolean);
  const totalKm = round1(all.reduce((s, r) => s + (r.km as number), 0));
  const summary = `${rows.length ? countLine(rows.length, all.length, 'vehicle') : '0 vehicles'} · ${tripCount} trips · ${totalKm} km over ${round1(days)} days`;
  const shownTo = (page - 1) * limit + rows.length;
  const nowLocal = naiveMs(localTime(ctx.now, acc.zone)) as number;
  const recent = nowLocal - (naiveMs(w.to) as number) < RECENT_HOURS * 3600_000;
  const help: string[] = [];
  if (shownTo < all.length)
    help.push(
      `Run \`ituran-axi trips ${[...plates, ...flagWords(values), '--by', 'plate', '--page', String(page + 1), ...(limit !== 20 ? ['--limit', String(limit)] : [])].join(' ')}\` for the next ${Math.min(limit, all.length - shownTo)}`,
    );
  help.push("Run `ituran-axi odometer --all` for each vehicle's odometer");
  help.push(
    `Run \`ituran-axi trips <plate> ${flagWords(values).join(' ')}\` for one vehicle's trips`,
  );
  return listOutput({
    key: 'vehicles',
    summary,
    head: {
      window: `${w.from} to ${w.to}`,
      zone: acc.zone,
      ...(partial ? { partial: `trips ${partial}; the totals are low` } : {}),
      ...(recent ? { note: LATE_NOTE } : {}),
    },
    rows,
    columns,
    help: help.slice(0, 3),
    full: values.full === true,
    narrower: 'ituran-axi trips --by plate --limit <n>',
  });
}

function flagWords(values: CommandInput['values']): string[] {
  const out: string[] = [];
  for (const f of ['since', 'from', 'to', 'date']) {
    const v = str(values[f]);
    if (v) out.push(`--${f}`, v);
  }
  return out;
}

const NO_FIX = (p: Row) => {
  const point = obj(obj(p.location).point);
  return (point.lat === 0 && point.lon === 0) || p.speed === -999;
};

export async function trip(input: CommandInput): Promise<string> {
  const ctx = open(input);
  const { values } = input;
  const id = input.positionals[0] as string;
  if (!/^\d{1,20}$/.test(id))
    throw usage('A trip id is a number, as `ituran-axi trips` lists it.');
  const full = values.full === true;
  const t = (await ctx.client.read({
    method: 'GET',
    path: api(ctx, `/trips/${id}`),
    ctx: { what: `trip ${id}`, trips: true },
  })) as Row | null;
  if (!t || typeof t !== 'object')
    throw new AxiError('ituran_error', 'Ituran sent no trip.');
  const r = tripRow(t);
  const start = obj(t.start_location);
  const end = obj(t.end_location);
  const doc: Row = {
    id: r.id,
    plate: r.plate,
    driver: r.driver ?? 'not identified',
    status: r.status,
    start: { time: r.start, address: r.from, odometer_km: start.odometer },
    end: { time: r.end, address: r.to, odometer_km: end.odometer },
    km: r.km,
    duration: r.duration,
    idle: r.idle,
    max_speed: r.max_speed,
  };
  const limit = intFlag(values.limit, 'limit', 50, 1, MAX_PAGE);
  if (values.points === true) {
    const json = await ctx.client.read({
      method: 'GET',
      path: api(ctx, `/trips/${id}/points`),
      query: { page_number: 1, page_size: Math.max(10, limit) },
      ctx: { what: `points of trip ${id}` },
      emptyOn404: true,
    });
    const all = rowsOf(json, 'trip_points');
    const located = all.filter((p) => !NO_FIX(p));
    const total = totalOf(json);
    doc.points_summary = `${countLine(Math.min(located.length, limit), total, 'point')}${all.length > located.length ? `; ${all.length - located.length} without a GPS fix left out` : ''}`;
    doc.points = located.slice(0, limit).map((p) => {
      const point = obj(obj(p.location).point);
      return {
        time: str(p.timestamp) ?? null,
        speed: p.speed ?? null,
        lat: point.lat ?? null,
        lon: point.lon ?? null,
      };
    });
  }
  if (values.safety === true) {
    const json = await ctx.client.read({
      method: 'GET',
      path: api(ctx, `/trips/${id}/safety`),
      ctx: { what: `safety events of trip ${id}` },
      emptyOn404: true,
    });
    const events = rowsOf(json, 'safety_events');
    doc.safety_events = events.length
      ? events.map(flatScalars)
      : '0 safety events';
  }
  if (values.speeding === true) {
    const json = await ctx.client.read({
      method: 'GET',
      path: api(ctx, `/trips/${id}/over-speeding`),
      ctx: { what: `speeding on trip ${id}` },
      emptyOn404: true,
    });
    const rows = Array.isArray(json)
      ? (json as Row[])
      : rowsOf(
          json,
          Object.keys(obj(json)).find((k) => Array.isArray(obj(json)[k])) ??
            'events',
        );
    doc.speeding = rows.length ? rows.map(flatScalars) : '0 speeding episodes';
  }
  return recordOutput(doc, full, `ituran-axi trip ${id}`);
}

/** The scalar fields of a row, one level of nesting flattened with dots. */
export function flatScalars(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null || typeof v !== 'object') out[k] = v;
    else if (!Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Row))
        if (v2 === null || typeof v2 !== 'object') out[`${k}.${k2}`] = v2;
    }
  }
  return out;
}

export async function totals(input: CommandInput): Promise<string> {
  const ctx = open(input);
  const { values } = input;
  const plate = input.positionals[0]
    ? normalizePlate(input.positionals[0])
    : undefined;
  const acc = await account(ctx);
  if (!plate) {
    const w = windowOf(windowFlags(values), acc.zone, ctx.now, '7d', 'date');
    const t = obj(
      await ctx.client.read({
        method: 'POST',
        path: api(ctx, '/trips/totals'),
        body: { from_date: w.from, to_date: w.to },
        ctx: { what: 'trip totals' },
      }),
    );
    return recordOutput(
      {
        window: `${w.from} to ${w.to} (whole days)`,
        trips: t.trips_count,
        vehicles: t.vehicles_count,
        drivers: t.drivers_count,
        km: round1(t.total_trips_distance),
        driving: hoursMinutes(t.total_trips_duration),
        idle: hoursMinutes(t.idle_duration),
        working: hoursMinutes(t.working_time_duration),
        fuel_l: t.fuel_consumption,
        note:
          typeof t.total_trips_distance === 'number' &&
          t.total_trips_distance < 0
            ? 'Ituran reported a negative distance; treat it as a fault upstream'
            : undefined,
        zone: acc.zone,
      },
      false,
      'ituran-axi totals --date <d>',
    );
  }
  const w = windowOf(windowFlags(values), acc.zone, ctx.now, '7d');
  const s = obj(
    await ctx.client.read({
      method: 'GET',
      path: api(ctx, '/trips/stats'),
      query: { license_plate: plate, from_date: w.from, to_date: w.to },
      ctx: { what: `trip statistics for ${plate}`, plate, trips: true },
    }),
  );
  const t = obj(s.totals);
  const periods = Array.isArray(s.stats) ? (s.stats as Row[]) : [];
  return recordOutput(
    {
      plate,
      window: `${w.from} to ${w.to}`,
      trips: t.trips_count,
      km: round1(t.distance),
      driving: hoursMinutes(t.duration),
      idle: hoursMinutes(t.idle_duration),
      safety: t.safety_grade,
      periods: periods.map((p) => ({
        start: str(p.period_start) ?? null,
        end: str(p.period_end) ?? null,
        trips: p.trips_count ?? null,
        km: round1(p.distance),
        driving: hoursMinutes(p.duration),
      })),
      zone: acc.zone,
    },
    values.full === true,
    `ituran-axi totals ${plate} --since 24h`,
  );
}
