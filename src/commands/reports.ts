// report and safety. BI reports cover every vehicle (Ituran ignores their plate
// filters, so plates are applied here). Operational reports take 1 to 5 plates
// and less than three days per request, page with an inclusive cursor, and can
// repeat a row at a page boundary; the walk splits and removes repeats.

import type { CommandInput } from '../cli/table.ts';
import { usage } from '../errors.ts';
import { normalizePlate } from '../plates.ts';
import { hoursMinutes, naiveMs, windowOf } from '../time.ts';
import { pickColumns } from './catalog.ts';
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
  rowsOf,
  str,
  totalOf,
  walkAll,
  windowRows,
} from './common.ts';
import { flatScalars } from './trips.ts';

const obj = (v: unknown): Row =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {};
const firstArray = (json: unknown): string => {
  const j = obj(json);
  return Object.keys(j).find((k) => Array.isArray(j[k])) ?? 'records';
};

const BI: Record<string, string> = {
  daily: 'daily',
  periodic: 'periodic',
  idle: 'idle_percentage',
};
const OPERATIONAL: Record<string, string> = {
  speed: 'speed-report',
  events: 'events-report',
  engine: 'engine-and-switch-activity',
  full: 'full-report',
  diagnostics: 'diagnostics-report',
  'heat-map': 'heat-map',
};
const MAX_PLATES = 5;
const MAX_SPAN_MS = 2 * 86_400_000 + 23 * 3_600_000;
const RECORDS_LIMIT = 1000;
/** BI and safety routes take pages of at most 1,000 rows. */
const REPORT_PAGE = 1000;

function windowFlags(values: CommandInput['values']) {
  return {
    since: str(values.since),
    from: str(values.from),
    to: str(values.to),
    date: str(values.date),
  };
}

function biRow(r: Row): Row {
  const f = flatScalars(r);
  const out: Row = {};
  for (const [k, v] of Object.entries(f)) {
    out[k] =
      typeof v === 'string' && /^P(T|\d)/.test(v) ? (hoursMinutes(v) ?? v) : v;
  }
  if (Array.isArray(r.license_plates))
    out.license_plates = (r.license_plates as unknown[]).join(' ');
  if (Array.isArray(r.driver_codes))
    out.driver_codes = (r.driver_codes as unknown[]).join(' ');
  return out;
}

function recordRow(r: Row): Row {
  const location = obj(r.location);
  const address = obj(location.address);
  const point = obj(location.point);
  const events = Array.isArray(r.events)
    ? (r.events as Row[])
        .map(
          (e) => str(e.event_name) ?? str(e.name) ?? str(e.description) ?? '',
        )
        .filter(Boolean)
        .join('; ')
    : null;
  const driver = obj(r.driver);
  const driverName = [str(driver.first_name), str(driver.last_name)]
    .filter((p) => p?.trim())
    .join(' ');
  return {
    time: str(r.timestamp) ?? null,
    plate: str(r.license_plate) ?? null,
    event: events || null,
    speed: typeof r.speed === 'number' ? r.speed : null,
    address: str(address.location) ?? null,
    driver: driverName || null,
    lat: point.lat ?? null,
    lon: point.lon ?? null,
    odometer: r.odometer ?? null,
    id: r.record_id ?? null,
  };
}

async function biReport(
  ctx: Ctx,
  input: CommandInput,
  name: string,
  plates: string[],
  zone: string,
): Promise<string> {
  const { values } = input;
  const by = values.drivers === true ? 'drivers' : 'vehicles';
  const w = windowOf(windowFlags(values), zone, ctx.now, '24h', 'date');
  const limit = intFlag(values.limit, 'limit', 20, 1, REPORT_PAGE);
  const page = intFlag(values.page, 'page', 1, 1, 100_000);
  let idleTotal: Row | null = null;
  const fetchPage: FetchPage = async (page_number, page_size) => {
    const json = await ctx.client.read({
      method: 'POST',
      path: api(ctx, `/reports/bi/${BI[name]}/${by}`),
      body: {
        from_date: w.from,
        to_date: w.to,
        ...(name === 'periodic' ? {} : {}),
      },
      query: { page_number, page_size },
      ctx: { what: `the ${name} BI report` },
      emptyOn404: true,
    });
    const idle = obj(obj(json).idle);
    if (Object.keys(idle).length) idleTotal = obj(idle.idle_total);
    return {
      rows: Object.keys(idle).length
        ? rowsOf(idle, 'idle_items')
        : rowsOf(json, firstArray(json)),
      total: json === null ? 0 : totalOf(json),
    };
  };
  let rows: Row[];
  let total: number | null;
  let note: string | undefined;
  if (plates.length) {
    const all = await walkAll(fetchPage, REPORT_PAGE);
    const wanted = new Set(plates);
    const hits = all.rows.filter(
      (r) =>
        wanted.has(String(r.license_plate)) ||
        (Array.isArray(r.license_plates) &&
          (r.license_plates as unknown[]).some((p) => wanted.has(String(p)))),
    );
    total = hits.length;
    rows = hits.slice((page - 1) * limit, page * limit);
    note =
      'Ituran ignores plate filters on BI reports, so the rows were filtered here.';
  } else {
    const got = await windowRows(fetchPage, page, limit);
    rows = got.rows;
    total = got.total;
  }
  const flat = rows.map(biRow);
  // Set by the page fetches above; TypeScript cannot see assignments made in them.
  const totals = idleTotal as Row | null;
  const preferred =
    name === 'daily'
      ? [
          'date',
          by === 'drivers' ? 'driver_code' : 'license_plate',
          'distance',
          'duration',
          'idle_duration',
        ]
      : [
          by === 'drivers' ? 'driver_code' : 'license_plate',
          'distance',
          'total_distance',
          'duration',
          'total_duration',
          'idle_duration',
          'working_time_duration',
        ];
  const shownTo = (page - 1) * limit + rows.length;
  return listOutput({
    key: 'rows',
    summary: `${rows.length ? countLine(rows.length, total, 'row') : '0 rows'} of the ${name} report by ${by.slice(0, -1)}`,
    head: {
      window: `${w.from} to ${w.to} (whole days)`,
      ...(totals && Object.keys(totals).length
        ? {
            total: {
              vehicles: totals.vehicles_count ?? null,
              drivers: totals.drivers_count ?? null,
              km: totals.distance ?? null,
              driving: hoursMinutes(totals.duration),
              idle: hoursMinutes(totals.idle_duration),
            },
          }
        : {}),
      ...(note ? { note } : {}),
    },
    rows: flat,
    columns: pickColumns(flat, preferred),
    help:
      total !== null && shownTo < total
        ? [
            `Run the same command with --page ${page + 1} for the next ${Math.min(limit, total - shownTo)}`,
          ]
        : [],
    full: values.full === true,
    narrower: `ituran-axi report ${name} --date <d>`,
  });
}

/** Split [from, to] into pieces Ituran accepts: less than three days each. */
function spans(from: string, to: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let start = naiveMs(from) as number;
  const end = naiveMs(to) as number;
  while (start <= end) {
    const stop = Math.min(end, start + MAX_SPAN_MS);
    out.push([
      new Date(start).toISOString().slice(0, 19),
      new Date(stop).toISOString().slice(0, 19),
    ]);
    start = stop + 1000;
  }
  return out;
}

async function operational(
  ctx: Ctx,
  input: CommandInput,
  name: string,
  plates: string[],
  zone: string,
): Promise<string> {
  const { values } = input;
  if (!plates.length)
    throw usage(
      `report ${name} needs 1 or more plates; Ituran runs it per vehicle.`,
    );
  if (name === 'heat-map' && plates.length !== 1)
    throw usage('report heat-map reads one vehicle: give one plate.');
  const w = windowOf(windowFlags(values), zone, ctx.now, '24h');
  const limit = intFlag(values.limit, 'limit', 20, 1, MAX_PAGE);
  const route = api(ctx, `/reports/${OPERATIONAL[name]}`);
  if (name === 'heat-map') {
    const json = obj(
      await ctx.client.read({
        method: 'POST',
        path: route,
        body: { license_plate: plates[0], from_date: w.from, to_date: w.to },
        ctx: { what: 'the heat map', plate: plates[0] as string },
      }),
    );
    const headers = Array.isArray(json.headers)
      ? (json.headers as unknown[]).map(String)
      : [];
    const records = Array.isArray(json.records)
      ? (json.records as unknown[][])
      : [];
    const rows = records.map((rec) =>
      Object.fromEntries(
        headers.map((h, i) => [h, Array.isArray(rec) ? rec[i] : null]),
      ),
    );
    return listOutput({
      key: 'points',
      summary: `${rows.length} heat-map points for ${plates[0]}; points are not in time order`,
      head: { window: `${w.from} to ${w.to}`, zone },
      rows: rows.slice(0, limit),
      columns: headers.slice(0, 5),
      help:
        rows.length > limit
          ? [
              `Run the same command with --limit ${Math.min(MAX_PAGE, rows.length)} for all ${rows.length}`,
            ]
          : [],
      full: values.full === true,
      narrower: `ituran-axi report heat-map ${plates[0]} --date <d>`,
    });
  }
  const over = name === 'speed' ? intFlag(values.over, 'over', 0, 1, 300) : 0;
  if (name === 'speed' && !over)
    throw usage('report speed needs --over <km/h>, the speed to report above.');
  const rows: Row[] = [];
  const seen = new Set<string>();
  let more = false;
  outer: for (let i = 0; i < plates.length; i += MAX_PLATES) {
    const chunk = plates.slice(i, i + MAX_PLATES);
    for (const [from, to] of spans(w.from, w.to)) {
      let cursor: unknown;
      for (;;) {
        const json = obj(
          await ctx.client.read({
            method: 'POST',
            path: route,
            body: {
              license_plates: chunk,
              from_date: from,
              to_date: to,
              records_limit: Math.min(
                RECORDS_LIMIT,
                Math.max(1, limit - rows.length + 1),
              ),
              ...(cursor !== undefined ? { from_record_id: cursor } : {}),
              ...(over ? { from_speed: over } : {}),
            },
            ctx: {
              what: `the ${name} report`,
              ...(chunk.length === 1 ? { plate: chunk[0] as string } : {}),
            },
            emptyOn404: true,
          }),
        );
        const records = Array.isArray(json.records)
          ? (json.records as Row[])
          : [];
        for (const r of records) {
          const key = String(r.record_id ?? JSON.stringify(r));
          if (seen.has(key)) continue;
          seen.add(key);
          rows.push(recordRow(r));
        }
        if (rows.length >= limit) {
          more = json.has_more === true || rows.length > limit;
          break outer;
        }
        if (
          json.has_more !== true ||
          json.last_record_id === undefined ||
          json.last_record_id === cursor
        )
          break;
        cursor = json.last_record_id;
      }
    }
  }
  const shown = rows.slice(0, limit);
  return listOutput({
    key: 'records',
    summary: `${shown.length} records of the ${name} report for ${plates.join(' ')}${more ? ', more exist' : ''}`,
    head: { window: `${w.from} to ${w.to}`, zone },
    rows: shown,
    columns: ['time', 'plate', 'event', 'speed', 'address'],
    help: more
      ? [
          `Run the same command with --limit ${Math.min(MAX_PAGE, limit * 5)} or a shorter window for more`,
        ]
      : [],
    full: values.full === true,
    narrower: `ituran-axi report ${name} <plate> --date <d>`,
  });
}

export async function report(input: CommandInput): Promise<string> {
  const name = input.positionals[0] as string;
  if (!(name in BI) && !(name in OPERATIONAL)) {
    throw usage(
      `Unknown report ${/^[a-z-]{1,30}$/.test(name) ? `"${name}"` : ''}. Reports: ${[...Object.keys(BI), ...Object.keys(OPERATIONAL)].join(', ')}.`,
    );
  }
  if (input.values.drivers === true && !(name in BI))
    throw usage('--drivers applies to the daily, periodic and idle reports.');
  const ctx = open(input);
  const plates = [...new Set(input.positionals.slice(1).map(normalizePlate))];
  const acc = await account(ctx);
  return name in BI
    ? biReport(ctx, input, name, plates, acc.zone)
    : operational(ctx, input, name, plates, acc.zone);
}

const SAFETY: Record<string, string> = {
  totals: '/safety/totals',
  vehicles: '/safety/vehicles',
  drivers: '/safety/drivers',
  periodic: '/safety/periodic',
  'ubi-vehicles': '/safety/ubi/vehicles',
  'ubi-drivers': '/safety/ubi/drivers',
};

export async function safety(input: CommandInput): Promise<string> {
  const view = input.positionals[0] ?? 'totals';
  const route = SAFETY[view];
  if (!route) throw usage(`safety takes ${Object.keys(SAFETY).join(', ')}.`);
  const ctx = open(input);
  const { values } = input;
  const acc = await account(ctx);
  const w = windowOf(windowFlags(values), acc.zone, ctx.now, '7d', 'date');
  const limit = intFlag(values.limit, 'limit', 20, 1, REPORT_PAGE);
  const page = intFlag(values.page, 'page', 1, 1, 100_000);
  const body = {
    from_date: w.from,
    to_date: w.to,
    ...(view === 'periodic' ? { period_type: 'daily' } : {}),
  };
  const head = { window: `${w.from} to ${w.to} (whole days)` };
  if (view === 'totals') {
    const json = obj(
      await ctx.client.read({
        method: 'POST',
        path: api(ctx, route),
        body,
        ctx: { what: 'safety grades' },
        emptyOn404: true,
      }),
    );
    const t = obj(json.totals);
    const groups = Array.isArray(t.event_groups)
      ? (t.event_groups as Row[]).map((g) => ({
          name: g.name ?? null,
          count: g.count ?? null,
        }))
      : [];
    return listOutput({
      key: 'event_groups',
      summary: json.totals
        ? `safety grade ${t.safety_grade ?? 'unknown'} · fuel grade ${t.fuel_grade ?? 'unknown'} · ${groups.reduce((s, g) => s + (typeof g.count === 'number' ? g.count : 0), 0)} safety events`
        : 'no safety data: the vehicles are not enrolled in Ituran safety, which says nothing about how they drive',
      head,
      rows: groups,
      columns: ['name', 'count'],
      help: ['Run `ituran-axi safety vehicles` for grades per vehicle'],
      full: values.full === true,
      narrower: 'ituran-axi safety totals --date <d>',
    });
  }
  const got = await windowRows(
    async (page_number, page_size) => {
      const json = await ctx.client.read({
        method: 'POST',
        path: api(ctx, route),
        body,
        query: { page_number, page_size },
        ctx: { what: 'safety grades' },
        emptyOn404: true,
      });
      return {
        rows: rowsOf(json, firstArray(json)),
        total: json === null ? 0 : totalOf(json),
      };
    },
    page,
    limit,
  );
  const rows = got.rows.map((r) => {
    const meta = obj(r.metadata);
    const grades = obj(r.grades);
    return Object.keys(grades).length
      ? {
          plate: meta.license_plate ?? null,
          driver: Array.isArray(meta.driver_codes)
            ? (meta.driver_codes as unknown[]).join(' ')
            : (meta.driver_code ?? null),
          safety: grades.safety_grade ?? null,
          fuel: grades.fuel_grade ?? null,
        }
      : flatScalars(r);
  });
  const shownTo = (page - 1) * limit + rows.length;
  return listOutput({
    key: 'grades',
    summary: rows.length
      ? `${countLine(rows.length, got.total, 'row')} of safety ${view}`
      : `0 rows of safety ${view}: no safety data, which says nothing about how they drive`,
    head,
    rows,
    // Driver views carry no plate; vehicle views lead with it.
    columns: view.endsWith('drivers')
      ? pickColumns(rows, ['driver', 'safety', 'fuel']).filter(
          (c) => c !== 'plate',
        )
      : pickColumns(rows, ['plate', 'driver', 'safety', 'fuel']),
    help:
      got.total !== null && shownTo < got.total
        ? [
            `Run the same command with --page ${page + 1} for the next ${Math.min(limit, got.total - shownTo)}`,
          ]
        : [],
    full: values.full === true,
    narrower: `ituran-axi safety ${view} --date <d>`,
  });
}
