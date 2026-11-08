// trips, trip and totals. Ituran matches a trip to a window by its end time,
// and lists a trip only some hours after it ends; the output says so when it
// matters. Totals for the whole account take dates, not times.

import type { CommandInput } from '../cli/table.ts';
import { AxiError, usage } from '../errors.ts';
import { normalizePlate } from '../plates.ts';
import { hoursMinutes, localTime, naiveMs, windowOf } from '../time.ts';
import {
  account,
  api,
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
  str,
  totalOf,
  windowRows,
} from './common.ts';

const obj = (v: unknown): Row =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {};
const round1 = (v: unknown) =>
  typeof v === 'number' ? Math.round(v * 10) / 10 : null;
const RECENT_HOURS = 6;
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
];

export async function trips(input: CommandInput): Promise<string> {
  const ctx = open(input);
  const { values } = input;
  const plates = [...new Set(input.positionals.map(normalizePlate))];
  const acc = await account(ctx);
  const w = windowOf(windowFlags(values), acc.zone, ctx.now, '24h');
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
  const fetchPage: FetchPage = async (page_number, page_size) => {
    const json = await ctx.client.read({
      method: 'GET',
      path: api(ctx, '/trips'),
      query: {
        ...(plates.length ? { license_plates: plates } : {}),
        from_date: w.from,
        to_date: w.to,
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
  const got = await windowRows(fetchPage, page, limit);
  const rows = got.rows.map(tripRow);
  const total = got.total;
  const whose = plates.length ? `for ${plates.join(' ')}` : 'for all vehicles';
  const nowLocal = naiveMs(localTime(ctx.now, acc.zone)) as number;
  const recent = nowLocal - (naiveMs(w.to) as number) < RECENT_HOURS * 3600_000;
  const everyRow = total !== null && rows.length === total;
  const km = everyRow
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
