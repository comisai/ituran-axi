// centers: Ituran's service centers, nearest first from a vehicle's last
// position or a point. Distances are computed here; positions never leave.

import type { CommandInput } from '../cli/table.ts';
import { AxiError } from '../errors.ts';
import {
  distanceKm,
  type Point,
  parsePoint,
  pointOf,
  roundKm,
} from '../geo.ts';
import { normalizePlate } from '../plates.ts';
import { age } from '../time.ts';
import {
  account,
  api,
  countLine,
  intFlag,
  listOutput,
  MAX_PAGE,
  open,
  type Row,
  rowsOf,
  str,
} from './common.ts';

const obj = (v: unknown): Row =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {};

export async function centers(input: CommandInput): Promise<string> {
  const ctx = open(input);
  const { values } = input;
  const limit = intFlag(values.limit, 'limit', 10, 1, MAX_PAGE);
  const acc = await account(ctx);
  let from: Point | null = null;
  let origin: Row = {};
  if (typeof values.near === 'string') {
    if (values.near.includes(',')) {
      from = parsePoint(values.near, 'near');
      origin = { from: `${from.lat},${from.lon}` };
    } else {
      const plate = normalizePlate(values.near);
      const v = obj(
        await ctx.client.read({
          method: 'GET',
          path: api(ctx, `/vehicles/${plate}`),
          query: { realtime_fields: ['LastLocation'] },
          ctx: { what: `vehicle ${plate}`, plate },
        }),
      );
      const loc = obj(v.last_location);
      const point = obj(obj(loc.location).point);
      from = pointOf(point.lat, point.lon);
      if (!from) {
        throw new AxiError(
          'not_found',
          `Vehicle ${plate} has reported no position, so there is nothing to measure from.`,
          { plate },
        );
      }
      origin = {
        from: `${plate}, last seen ${age(loc.timestamp, ctx.now, acc.zone) ?? 'at an unknown time'} ago`,
      };
    }
  }
  const json = await ctx.client.read({
    method: 'GET',
    path: api(ctx, '/info/ituran-service-centers'),
    ctx: { what: 'service centers' },
    emptyOn404: true,
  });
  const rows = rowsOf(json, 'service_centers').map((c) => {
    const location = obj(c.location);
    const point = obj(location.point);
    const at = pointOf(point.lat, point.lon);
    const address = location.address;
    return {
      name: str(c.name) ?? null,
      km: from && at ? roundKm(distanceKm(from, at)) : null,
      address:
        typeof address === 'string'
          ? address
          : (str(obj(address).location) ?? null),
      phone: str(c.phone) ?? null,
      hours: str(c.opening_hours) ?? null,
    };
  });
  if (from) rows.sort((a, b) => (a.km ?? Infinity) - (b.km ?? Infinity));
  const shown = rows.slice(0, limit);
  return listOutput({
    key: 'centers',
    summary: rows.length
      ? `${countLine(shown.length, rows.length, 'Ituran service center')}${from ? ', nearest first' : ''}`
      : '0 Ituran service centers',
    head: origin,
    rows: shown,
    columns: from
      ? ['name', 'km', 'address', 'phone']
      : ['name', 'address', 'phone', 'hours'],
    help: from
      ? []
      : ['Run `ituran-axi centers --near <plate>` for the nearest ones'],
    full: values.full === true,
    narrower: 'ituran-axi centers --near <plate> --limit <n>',
  });
}
