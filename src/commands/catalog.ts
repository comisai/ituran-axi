// groups, events, event and alerts: the account's own definitions. Their names
// are written by people and can differ by whitespace alone, so they are shown
// as Ituran sends them, escaped but never trimmed.

import type { CommandInput } from '../cli/table.ts';
import { usage } from '../errors.ts';
import { normalizePlate } from '../plates.ts';
import {
  account,
  api,
  countLine,
  intFlag,
  listOutput,
  MAX_PAGE,
  open,
  type Row,
  recordOutput,
  rowsOf,
  str,
} from './common.ts';
import { flatScalars } from './trips.ts';

const obj = (v: unknown): Row =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {};

function flattenGroups(
  groups: Row[],
  depth: number,
  parent: string | null,
  out: Row[],
): void {
  for (const g of groups) {
    const children = Array.isArray(g.child_groups)
      ? (g.child_groups as Row[])
      : [];
    out.push({
      id: g.vehicle_group_id ?? g.id ?? null,
      name: str(g.vehicle_group_name) ?? str(g.name) ?? null,
      depth,
      parent,
      subgroups: children.length,
    });
    flattenGroups(
      children,
      depth + 1,
      String(g.vehicle_group_id ?? g.id ?? ''),
      out,
    );
  }
}

export async function groups(input: CommandInput): Promise<string> {
  const ctx = open(input);
  const id = input.positionals[0];
  const full = input.values.full === true;
  if (id !== undefined) {
    if (!/^\d{1,20}$/.test(id))
      throw usage('A group id is a number, as `ituran-axi groups` lists it.');
    const g = obj(
      await ctx.client.read({
        method: 'GET',
        path: api(ctx, `/vehicle-groups/${id}`),
        ctx: { what: `vehicle group ${id}` },
      }),
    );
    return recordOutput(g, full, `ituran-axi groups ${id}`);
  }
  const json = await ctx.client.read({
    method: 'GET',
    path: api(ctx, '/vehicle-groups'),
    ctx: { what: 'vehicle groups' },
    emptyOn404: true,
  });
  const rows: Row[] = [];
  flattenGroups(rowsOf(json, 'vehicle_groups'), 0, null, rows);
  return listOutput({
    key: 'groups',
    summary: rows.length
      ? countLine(rows.length, rows.length, 'vehicle group')
      : '0 vehicle groups',
    rows,
    columns: ['id', 'name', 'depth', 'parent'],
    help: rows.length ? ['Run `ituran-axi groups <id>` for one group'] : [],
    full,
    narrower: 'ituran-axi groups <id>',
  });
}

export async function events(input: CommandInput): Promise<string> {
  const ctx = open(input);
  const limit = intFlag(input.values.limit, 'limit', 20, 1, MAX_PAGE);
  const json = await ctx.client.read({
    method: 'GET',
    path: api(ctx, '/events/stats'),
    ctx: { what: 'event states' },
    emptyOn404: true,
  });
  const all = rowsOf(json, 'events').map((e) => ({
    id: e.event_id ?? null,
    name: str(e.event_name) ?? null,
    vehicles: typeof e.num_of_vehicles === 'number' ? e.num_of_vehicles : 0,
  }));
  const active = all
    .filter((e) => e.vehicles > 0)
    .sort((a, b) => b.vehicles - a.vehicles);
  const chosen =
    input.values.all === true
      ? [...all].sort((a, b) => b.vehicles - a.vehicles)
      : active;
  const rows = chosen.slice(0, limit);
  return listOutput({
    key: 'events',
    summary: `${all.length} event states · ${active.length} with vehicles in them now${rows.length < chosen.length ? ` · ${rows.length} shown` : ''}`,
    rows,
    columns: ['id', 'name', 'vehicles'],
    help: rows.length
      ? ['Run `ituran-axi event <id>` for the vehicles in one state']
      : [],
    full: input.values.full === true,
    narrower: 'ituran-axi events --limit <n>',
  });
}

const PREFERRED = [
  'license_plate',
  'nickname',
  'vehicle_nickname',
  'timestamp',
  'start_time',
  'status',
  'event_name',
];

/** Pick columns for rows of a shape Ituran does not document: known keys first, then scalars. */
export function pickColumns(
  rows: Row[],
  preferred: readonly string[] = PREFERRED,
  max = 5,
): string[] {
  const keys: string[] = [];
  for (const r of rows.slice(0, 20))
    for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
  const ordered = [
    ...preferred.filter((k) => keys.includes(k)),
    ...keys.filter((k) => !preferred.includes(k)),
  ];
  return ordered.slice(0, max);
}

export async function event(input: CommandInput): Promise<string> {
  const ctx = open(input);
  const id = input.positionals[0] as string;
  if (!/^\d{1,20}$/.test(id))
    throw usage('An event id is a number, as `ituran-axi events` lists it.');
  const limit = intFlag(input.values.limit, 'limit', 20, 1, MAX_PAGE);
  const json = await ctx.client.read({
    method: 'GET',
    path: api(ctx, `/events/${id}/vehicles`),
    ctx: { what: `vehicles in event state ${id}` },
    emptyOn404: true,
  });
  const all = rowsOf(json, 'vehicles').map(flatScalars);
  const rows = all.slice(0, limit);
  return listOutput({
    key: 'vehicles',
    summary: rows.length
      ? countLine(rows.length, all.length, 'vehicle') +
        ` in event state ${id} now`
      : `0 vehicles in event state ${id} now`,
    rows,
    columns: pickColumns(all),
    help: rows.length
      ? ['Run `ituran-axi vehicle <plate>` for one vehicle']
      : [],
    full: input.values.full === true,
    narrower: `ituran-axi event ${id} --limit <n>`,
  });
}

export async function alerts(input: CommandInput): Promise<string> {
  const ctx = open(input);
  const limit = intFlag(input.values.limit, 'limit', 20, 1, MAX_PAGE);
  const plate =
    typeof input.values.plate === 'string'
      ? normalizePlate(input.values.plate)
      : undefined;
  await account(ctx);
  const json = await ctx.client.read({
    method: 'GET',
    path: api(ctx, plate ? `/vehicles/${plate}/alerts` : '/alerts'),
    ctx: {
      what: plate ? `alerts for ${plate}` : 'alerts',
      ...(plate ? { plate } : {}),
    },
    emptyOn404: true,
  });
  const raw = rowsOf(json, 'alerts');
  // Ituran repeats alert rows; one row per alert id.
  const seen = new Set<string>();
  const unique = raw.filter((a) => {
    const key = String(a.alert_id ?? a.id ?? JSON.stringify(a));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const all = unique.map(flatScalars);
  const rows = all.slice(0, limit);
  const repeated = raw.length - unique.length;
  return listOutput({
    key: 'alerts',
    summary: `${rows.length ? countLine(rows.length, all.length, 'alert definition') : '0 alert definitions'}${plate ? ` reach ${plate}` : ''}${repeated ? ` · ${repeated} repeated rows removed` : ''}`,
    rows,
    columns: pickColumns(all, [
      'alert_id',
      'alert_name',
      'alert_type',
      'alert_status',
      'is_active',
    ]),
    help: [],
    full: input.values.full === true,
    narrower: 'ituran-axi alerts --limit <n>',
  });
}

export { obj };
