// diagnostics, maintenance, temps and odometer: readings from sensors and
// schedules. Each reading keeps its own time: a reading hours or months old is
// shown with its age, never as the current state.

import type { CommandInput } from '../cli/table.ts';
import { usage } from '../errors.ts';
import { normalizePlate } from '../plates.ts';
import { age, windowOf } from '../time.ts';
import { pickColumns } from './catalog.ts';
import {
  account,
  api,
  type Ctx,
  countLine,
  intFlag,
  listOutput,
  MAX_PAGE,
  open,
  type Row,
  rowsOf,
  str,
  totalOf,
  walkAll,
} from './common.ts';
import { flatScalars } from './trips.ts';

const obj = (v: unknown): Row =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {};

function readingRows(
  plate: unknown,
  items: unknown,
  now: Date,
  zone: string,
  extra: Row = {},
): Row[] {
  if (!Array.isArray(items)) return [];
  return items.map((d) => {
    const f = flatScalars(obj(d));
    const time = str(f.timestamp) ?? str(f.time) ?? str(extra.time);
    return {
      plate: plate ?? null,
      channel: f.name ?? f.diagnostic_name ?? f.key ?? null,
      label: f.label ?? f.description ?? null,
      value: f.value ?? f.diagnostic_value ?? null,
      age: age(time, now, zone),
      ...extra,
      time: time ?? null,
    };
  });
}

export async function diagnostics(input: CommandInput): Promise<string> {
  const ctx = open(input);
  const { values } = input;
  const plates = [...new Set(input.positionals.map(normalizePlate))];
  const every = values.all === true;
  if (every === plates.length > 0)
    throw usage('Give plates, or --all for every vehicle, not both.');
  if (every && values.history === true)
    throw usage('--history reads one vehicle: give one plate.');
  const acc = await account(ctx);
  const limit = intFlag(values.limit, 'limit', 20, 1, MAX_PAGE);
  const names =
    typeof values.names === 'string'
      ? values.names
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  let rows: Row[] = [];
  let summary: string;
  if (values.history === true) {
    if (plates.length !== 1)
      throw usage('--history reads one vehicle: give one plate.');
    // Ituran keeps history reads to one day.
    const w = windowOf({ date: str(values.date) }, acc.zone, ctx.now, '24h');
    const all = await walkAll(async (page_number, page_size) => {
      const json = await ctx.client.read({
        method: 'POST',
        path: api(ctx, '/diagnostics/history'),
        body: {
          filter: { license_plates: plates, from_date: w.from, to_date: w.to },
        },
        query: { page_number, page_size },
        ctx: {
          what: `diagnostics history for ${plates[0]}`,
          plate: plates[0] as string,
        },
        emptyOn404: true,
      });
      return {
        rows: rowsOf(json, 'records'),
        total: json === null ? 0 : totalOf(json),
      };
    }, 100);
    for (const rec of all.rows) {
      rows.push(
        ...readingRows(rec.license_plate, rec.diagnostics, ctx.now, acc.zone, {
          time: rec.timestamp,
          speed: rec.speed ?? null,
        }),
      );
    }
    if (names.length)
      rows = rows.filter((r) => names.includes(String(r.channel)));
    summary = `${rows.length} readings for ${plates[0]} from ${w.from} to ${w.to}${all.partial ? ` (partial: ${all.partial})` : ''}`;
  } else {
    // "*" asks for every vehicle the account sees; pages go by vehicle.
    const all = await walkAll(
      async (page_number, page_size) => {
        const json = await ctx.client.read({
          method: 'POST',
          path: api(ctx, '/diagnostics'),
          body: {
            filter: {
              license_plates: every ? ['*'] : plates,
              ...(names.length ? { diagnostic_names: names } : {}),
            },
          },
          query: { page_number, page_size },
          ctx: {
            what: 'diagnostics',
            ...(plates.length === 1 ? { plate: plates[0] as string } : {}),
          },
          emptyOn404: true,
        });
        return {
          rows: rowsOf(json, 'vehicles'),
          total: json === null ? 0 : totalOf(json),
        };
      },
      every ? 500 : Math.max(10, plates.length),
    );
    let reporting = 0;
    for (const v of all.rows) {
      const found = readingRows(
        v.license_plate,
        v.diagnostics,
        ctx.now,
        acc.zone,
      );
      if (found.length) reporting++;
      rows.push(...found);
    }
    summary = every
      ? `${rows.length} latest readings from ${reporting} of ${all.rows.length} vehicles; each has its own time, and many are old${all.partial ? ` (partial: ${all.partial})` : ''}`
      : `${rows.length} latest readings for ${plates.join(' ')}; each has its own time, and many are old`;
  }
  return listOutput({
    key: 'readings',
    summary,
    head: { zone: acc.zone },
    rows: rows.slice(0, limit),
    columns: ['plate', 'channel', 'label', 'value', 'age'],
    help:
      rows.length > limit
        ? [
            `Run the same command with --limit ${Math.min(MAX_PAGE, rows.length)} for all ${rows.length}`,
          ]
        : [],
    full: values.full === true,
    narrower: 'ituran-axi diagnostics <plate> --names <a,b>',
  });
}

export async function maintenance(input: CommandInput): Promise<string> {
  const ctx = open(input);
  const { values } = input;
  const limit = intFlag(values.limit, 'limit', 20, 1, MAX_PAGE);
  const plate = input.positionals[0]
    ? normalizePlate(input.positionals[0])
    : undefined;
  if (values.types === true) {
    const json = await ctx.client.read({
      method: 'GET',
      path: '/api/v1/maintenance/type',
      ctx: { what: 'maintenance types' },
      emptyOn404: true,
    });
    const all = rowsOf(json, 'treatments').map(flatScalars);
    return listOutput({
      key: 'types',
      summary: all.length
        ? countLine(Math.min(limit, all.length), all.length, 'treatment type')
        : '0 treatment types',
      rows: all.slice(0, limit),
      columns: pickColumns(all, ['id', 'name']),
      help: [],
      full: values.full === true,
      narrower: 'ituran-axi maintenance --types --limit <n>',
    });
  }
  // A 404 here means the account keeps no maintenance records.
  const json = await ctx.client.read({
    method: 'GET',
    path: plate
      ? `/api/v1/vehicles/${plate}/maintenance`
      : '/api/v1/maintenance/treatments',
    ctx: {
      what: plate ? `maintenance for ${plate}` : 'maintenance',
      ...(plate ? { plate } : {}),
    },
    emptyOn404: true,
  });
  const first =
    json && typeof json === 'object' && !Array.isArray(json)
      ? Object.keys(json).find((k) => Array.isArray((json as Row)[k]))
      : undefined;
  const all = rowsOf(json, first ?? 'treatments').map(flatScalars);
  return listOutput({
    key: 'treatments',
    summary: all.length
      ? `${countLine(Math.min(limit, all.length), all.length, 'treatment record')}${plate ? ` for ${plate}` : ''}`
      : `0 treatment records${plate ? ` for ${plate}` : ''}: this account keeps no maintenance records in Ituran`,
    rows: all.slice(0, limit),
    columns: pickColumns(all, [
      'license_plate',
      'treatment_name',
      'name',
      'date',
      'odometer',
      'next',
    ]),
    help: [],
    full: values.full === true,
    narrower: 'ituran-axi maintenance <plate>',
  });
}

export async function temps(input: CommandInput): Promise<string> {
  const ctx = open(input);
  const { values } = input;
  const view = input.positionals[0] ?? 'current';
  const limit = intFlag(values.limit, 'limit', 20, 1, MAX_PAGE);
  const acc = await account(ctx);
  const what = 'temperature sensors (ITC)';
  if (view === 'current') {
    const json = await ctx.client.read({
      method: 'GET',
      path: '/api/v1/temperatures/current',
      ctx: { what },
      emptyOn404: true,
    });
    const rows: Row[] = [];
    for (const v of rowsOf(json, 'vehicles')) {
      for (const s of Array.isArray(v.sensors_data)
        ? (v.sensors_data as Row[])
        : []) {
        const f = flatScalars(obj(s));
        rows.push({
          plate: v.license_plate ?? null,
          sensor: f.sensor_number ?? f.sensor_id ?? null,
          celsius: f.temperature ?? f.value ?? null,
          age: age(v.timestamp, ctx.now, acc.zone),
        });
      }
    }
    return listOutput({
      key: 'sensors',
      summary: `${rows.length} sensor readings; a reading of -50 means a disconnected sensor`,
      head: { zone: acc.zone },
      rows: rows.slice(0, limit),
      columns: ['plate', 'sensor', 'celsius', 'age'],
      help: [],
      full: values.full === true,
      narrower: 'ituran-axi temps current --limit <n>',
    });
  }
  if (view !== 'history' && view !== 'breaches')
    throw usage('temps takes current, history <plate> or breaches.');
  const plate = input.positionals[1]
    ? normalizePlate(input.positionals[1])
    : undefined;
  if (view === 'history' && !plate) throw usage('temps history needs a plate.');
  const w = windowOf(
    {
      since: str(values.since),
      from: str(values.from),
      to: str(values.to),
      date: str(values.date),
    },
    acc.zone,
    ctx.now,
    '24h',
  );
  const json = await ctx.client.read({
    method: 'GET',
    path:
      view === 'history'
        ? '/api/v1/temperatures/report'
        : '/api/v1/temperatures/exceptions',
    query: {
      ...(plate ? { license_plate: plate } : {}),
      from_date: w.from,
      // The report samples every this many minutes; Ituran requires it.
      ...(view === 'history' ? { to_date: w.to, data_frequency: 60 } : {}),
    },
    ctx: { what, ...(plate ? { plate } : {}) },
    emptyOn404: true,
  });
  const first =
    json && typeof json === 'object' && !Array.isArray(json)
      ? Object.keys(json).find((k) => Array.isArray((json as Row)[k]))
      : undefined;
  const all = rowsOf(json, first ?? 'records').map(flatScalars);
  return listOutput({
    key: view === 'history' ? 'readings' : 'breaches',
    summary: `${countLine(Math.min(limit, all.length), all.length, view === 'history' ? 'reading' : 'breach', view === 'history' ? 'readings' : 'breaches')} from ${w.from}`,
    head: { zone: acc.zone },
    rows: all.slice(0, limit),
    columns: pickColumns(all),
    help: [],
    full: values.full === true,
    narrower: `ituran-axi temps ${view} --limit <n>`,
  });
}

async function allPlates(ctx: Ctx): Promise<string[]> {
  const all = await walkAll(async (page_number, page_size) => {
    const json = await ctx.client.read({
      method: 'GET',
      path: api(ctx, '/vehicles'),
      query: { page_number, page_size },
      ctx: { what: 'vehicles' },
      emptyOn404: true,
    });
    return {
      rows: rowsOf(json, 'vehicles'),
      total: json === null ? 0 : totalOf(json),
    };
  }, 500);
  return all.rows
    .map((v) => str(v.license_plate))
    .filter((p): p is string => !!p);
}

export async function odometer(input: CommandInput): Promise<string> {
  const ctx = open(input);
  const { values } = input;
  const limit = intFlag(values.limit, 'limit', 20, 1, MAX_PAGE);
  const acc = await account(ctx);
  let plates = [...new Set(input.positionals.map(normalizePlate))];
  if (!plates.length) {
    if (values.all !== true)
      throw usage('Give plates, or --all for every vehicle.');
    plates = await allPlates(ctx);
  }
  const rows: Row[] = [];
  // This route pages through its body, not its query.
  for (let i = 0; i < plates.length; i += 500) {
    const chunk = plates.slice(i, i + 500);
    const json = await ctx.client.read({
      method: 'POST',
      path: api(ctx, '/virtual-odometer'),
      body: {
        license_plates: chunk,
        page_number: 1,
        page_size: Math.max(10, chunk.length),
      },
      ctx: { what: 'odometer estimates' },
      emptyOn404: true,
    });
    for (const p of rowsOf(json, 'plates')) {
      rows.push({
        plate: p.license_plate ?? null,
        km:
          typeof p.virtual_odometer === 'number'
            ? Math.round(p.virtual_odometer)
            : null,
        reliability: p.reliability ?? null,
        age: age(p.timestamp, ctx.now, acc.zone),
      });
    }
  }
  return listOutput({
    key: 'odometers',
    summary: `${rows.length} of ${plates.length} vehicles have a GPS odometer estimate; check reliability before trusting one`,
    head: { zone: acc.zone },
    rows: rows.slice(0, limit),
    columns: ['plate', 'km', 'reliability', 'age'],
    help:
      rows.length > limit
        ? [
            `Run the same command with --limit ${Math.min(MAX_PAGE, rows.length)} for all ${rows.length}`,
          ]
        : [],
    full: values.full === true,
    narrower: 'ituran-axi odometer <plate>...',
  });
}
