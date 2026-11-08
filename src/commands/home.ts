// The home view: live state, not help. Two reads: the signed-in user and one
// page of vehicles for the count.

import type { CommandInput } from '../cli/table.ts';
import { render } from '../output/toon.ts';
import {
  account,
  api,
  binPath,
  environmentOf,
  open,
  totalOf,
} from './common.ts';

export const DESCRIPTION =
  'Read Ituran vehicle tracking: vehicles, positions, trips, drivers, saved places, events and reports';

export async function home(input: CommandInput): Promise<string> {
  const ctx = open(input);
  const acc = await account(ctx, true);
  const first = await ctx.client.read({
    method: 'GET',
    path: api(ctx, '/vehicles'),
    query: { page_number: 1, page_size: 10 },
    ctx: { what: 'vehicles' },
    emptyOn404: true,
  });
  const total = first === null ? 0 : totalOf(first);
  const who = [
    acc.customer,
    acc.user ? `user ${acc.user}${acc.role ? ` (${acc.role})` : ''}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const unavailable = Object.keys(acc.unavailable);
  const doc = {
    bin: binPath(process.argv[1]),
    description: DESCRIPTION,
    account: who || 'unknown',
    api: `${ctx.settings.url} (${environmentOf(ctx.settings.url)})`,
    zone:
      acc.zoneName && acc.zoneName !== acc.zone
        ? `${acc.zone} (${acc.zoneName})`
        : acc.zone,
    vehicles: total ?? 'unknown',
    ...(unavailable.length
      ? { not_on_this_account: unavailable.join(', ') }
      : {}),
  };
  return render(doc, [
    "Run `ituran-axi where --all` for every vehicle's last position",
    "Run `ituran-axi trips <plate> --since 24h` for a vehicle's trips",
    'Run `ituran-axi vehicles <text>` to find a vehicle by plate, name or model',
  ]);
}
