// Dispatch: home view with no command, help and version, then one command.
// Everything goes to stdout. Exit codes: 0 ok, 1 error, 2 usage.

import { encode } from '@toon-format/toon';
import { cacheDir, noteAvailable, noteUnavailable } from '../account.ts';
import { forgetToken } from '../auth.ts';
import { alerts, event, events, groups } from '../commands/catalog.ts';
import { centers } from '../commands/centers.ts';
import { driver, drivers } from '../commands/drivers.ts';
import { DESCRIPTION, home } from '../commands/home.ts';
import { place, places } from '../commands/places.ts';
import {
  diagnostics,
  maintenance,
  odometer,
  temps,
} from '../commands/readings.ts';
import { report, safety } from '../commands/reports.ts';
import { totals, trip, trips } from '../commands/trips.ts';
import { vehicle, vehicles, where } from '../commands/vehicles.ts';
import { connected, readSettings } from '../config.ts';
import { AxiError, usage } from '../errors.ts';
import { errorText, helpBlock, render } from '../output/toon.ts';
import { VERSION } from '../version.ts';
import { parseCommand } from './parse.ts';
import {
  BIN,
  type CommandSpec,
  commandName,
  type FlagSpec,
  type Io,
  usageLine,
} from './table.ts';

const LIMIT: FlagSpec = {
  type: 'string',
  value: '<n>',
  summary: 'Rows to show, default 20',
};
const PAGE: FlagSpec = {
  type: 'string',
  value: '<n>',
  summary: 'Page number, default 1',
};
const FULL: FlagSpec = {
  type: 'boolean',
  summary: 'Every field, without the size limit',
};
const FIELDS: FlagSpec = {
  type: 'string',
  value: '<a,b>',
  summary: 'Columns to show; --help lists them',
};
const WINDOW: Record<string, FlagSpec> = {
  since: {
    type: 'string',
    value: '<span>',
    summary: 'From this long ago: 90m, 24h, 7d',
  },
  from: {
    type: 'string',
    value: '<time>',
    summary: "From YYYY-MM-DD or YYYY-MM-DDTHH:mm, the account's local time",
  },
  to: {
    type: 'string',
    value: '<time>',
    summary: 'Until this time; default now',
  },
  date: { type: 'string', value: '<YYYY-MM-DD>', summary: 'One local day' },
};

/** A command and the Ituran service whose 403 it can meet, for the home view. */
type Spec = CommandSpec & { service?: string };

export const COMMANDS: readonly Spec[] = [
  {
    name: '',
    args: [],
    flags: {},
    summary: 'Home view: account, zone, vehicles, next steps',
    run: home,
  },
  {
    name: 'vehicles',
    args: [{ name: '<text>', required: false, variadic: true }],
    flags: {
      fields: {
        ...FIELDS,
        summary:
          'Columns: plate, name, model, make, year, status, color, age, time, speed, limit, lat, lon, address, odometer, driver, places',
      },
      limit: LIMIT,
      page: PAGE,
      full: FULL,
    },
    summary: 'List vehicles, or find them by plate, name, make or model',
    run: vehicles,
  },
  {
    name: 'vehicle',
    args: [{ name: '<plate>', required: true }],
    flags: {
      full: {
        type: 'boolean',
        summary: "Also the VIN, IDs and the driver's phone",
      },
    },
    summary: 'One vehicle: position, driver and saved places',
    run: vehicle,
  },
  {
    name: 'where',
    args: [{ name: '<plate>', required: false, variadic: true }],
    flags: {
      all: {
        type: 'boolean',
        summary: 'Every vehicle (the default with no plates)',
      },
      stale: {
        type: 'string',
        value: '<span>',
        summary:
          'List only vehicles last seen longer ago than this, such as 2h',
      },
      near: {
        type: 'string',
        value: '<lat,lon>',
        summary: 'Nearest first from this point, with a km column',
      },
      within: {
        type: 'string',
        value: '<km>',
        summary: 'With --near: only vehicles this close',
      },
      fields: {
        ...FIELDS,
        summary:
          'Columns: plate, name, model, make, year, status, age, time, speed, limit, lat, lon, address, odometer, driver, places, km',
      },
      limit: LIMIT,
      page: PAGE,
      full: FULL,
    },
    summary: 'Last positions with their age',
    run: where,
  },
  {
    name: 'trips',
    args: [{ name: '<plate>', required: false, variadic: true }],
    flags: {
      ...WINDOW,
      fields: {
        ...FIELDS,
        summary:
          'Columns: id, plate, start, end, km, driver, duration, idle, max_speed, safety, events, from, to, status, start_lat, start_lon, end_lat, end_lon',
      },
      limit: LIMIT,
      page: PAGE,
      full: FULL,
    },
    summary: 'Trips in a window, default the last 24h',
    run: trips,
  },
  {
    name: 'trip',
    args: [{ name: '<id>', required: true }],
    flags: {
      points: { type: 'boolean', summary: "The route's points" },
      safety: { type: 'boolean', summary: "The trip's safety events" },
      speeding: { type: 'boolean', summary: "The trip's over-speed episodes" },
      limit: {
        type: 'string',
        value: '<n>',
        summary: 'Points to show, default 50',
      },
      full: FULL,
    },
    summary: 'One trip, with --points, --safety or --speeding',
    run: trip,
  },
  {
    name: 'totals',
    args: [{ name: '<plate>', required: false }],
    flags: { ...WINDOW, full: FULL },
    summary: 'Trip totals for the account or one vehicle',
    run: totals,
  },
  {
    name: 'odometer',
    args: [{ name: '<plate>', required: false, variadic: true }],
    flags: {
      all: { type: 'boolean', summary: 'Every vehicle' },
      limit: LIMIT,
      page: PAGE,
      full: FULL,
    },
    summary: 'GPS odometer estimates',
    run: odometer,
  },
  {
    name: 'centers',
    args: [],
    flags: {
      near: {
        type: 'string',
        value: '<plate|lat,lon>',
        summary: "Nearest first from a vehicle's last position or a point",
      },
      limit: {
        type: 'string',
        value: '<n>',
        summary: 'Rows to show, default 10',
      },
      full: FULL,
    },
    summary: 'Ituran service centers, nearest first',
    run: centers,
  },
  {
    name: 'drivers',
    args: [{ name: '<text>', required: false, variadic: true }],
    flags: {
      fields: {
        ...FIELDS,
        summary: 'Columns: id, name, code, blocked, managed_code, phone, email',
      },
      limit: LIMIT,
      page: PAGE,
      full: FULL,
    },
    summary: 'List drivers, or find them by name or code',
    run: drivers,
  },
  {
    name: 'driver',
    args: [{ name: '<id>', required: true }],
    flags: {
      full: { type: 'boolean', summary: 'Also phone, e-mail and ID number' },
    },
    summary: 'One driver',
    run: driver,
  },
  {
    name: 'places',
    args: [{ name: '<text>', required: false, variadic: true }],
    flags: {
      refresh: {
        type: 'boolean',
        summary: 'Rebuild the local index of place names now',
      },
      limit: LIMIT,
      page: PAGE,
      full: FULL,
    },
    summary: 'List saved places, or find them by name',
    run: places,
  },
  {
    name: 'place',
    args: [{ name: '<id>', required: true }],
    flags: {
      vehicles: { type: 'boolean', summary: 'The vehicles in this place now' },
      refresh: {
        type: 'boolean',
        summary: 'Rebuild the local index of place names now',
      },
      full: FULL,
    },
    summary: 'One saved place, and the vehicles in it now',
    run: place,
  },
  {
    name: 'groups',
    args: [{ name: '<id>', required: false }],
    flags: { full: FULL },
    summary: 'Vehicle groups, or one group',
    run: groups,
  },
  {
    name: 'events',
    args: [],
    flags: {
      all: {
        type: 'boolean',
        summary: 'Include definitions with no vehicles in that state',
      },
      limit: LIMIT,
      full: FULL,
    },
    summary: 'Event states with the number of vehicles in each now',
    run: events,
  },
  {
    name: 'event',
    args: [{ name: '<id>', required: true }],
    flags: { limit: LIMIT, full: FULL },
    summary: 'The vehicles in one event state now',
    run: event,
  },
  {
    name: 'alerts',
    args: [],
    flags: {
      plate: {
        type: 'string',
        value: '<plate>',
        summary: 'Alerts that reach one vehicle',
      },
      limit: LIMIT,
      full: FULL,
    },
    summary: 'Alert definitions',
    run: alerts,
  },
  {
    name: 'diagnostics',
    args: [{ name: '<plate>', required: false, variadic: true }],
    flags: {
      all: { type: 'boolean', summary: 'Every vehicle the account sees' },
      names: {
        type: 'string',
        value: '<a,b>',
        summary: 'Only these channels, such as Diagnostic_60 (fuel level %)',
      },
      history: {
        type: 'boolean',
        summary: 'Readings over one day (--date) instead of the latest',
      },
      date: WINDOW.date as FlagSpec,
      limit: LIMIT,
      full: FULL,
    },
    summary: 'Sensor readings, latest or over one day',
    run: diagnostics,
  },
  {
    name: 'report',
    args: [
      { name: '<name>', required: true },
      { name: '<plate>', required: false, variadic: true },
    ],
    flags: {
      ...WINDOW,
      drivers: {
        type: 'boolean',
        summary: 'By driver instead of by vehicle (daily, periodic, idle)',
      },
      over: {
        type: 'string',
        value: '<km/h>',
        summary: 'The speed to report above (speed report)',
      },
      limit: LIMIT,
      page: PAGE,
      full: FULL,
    },
    summary:
      'daily, periodic, idle; or speed, events, engine, full, diagnostics, heat-map for plates',
    run: report,
    service: 'reports',
  },
  {
    name: 'safety',
    args: [{ name: '<view>', required: false }],
    flags: {
      ...WINDOW,
      by: {
        type: 'string',
        value: '<day|month>',
        summary: 'Periodic buckets, default day',
      },
      limit: LIMIT,
      page: PAGE,
      full: FULL,
    },
    summary:
      'Safety grades: totals, vehicles, drivers, groups, periodic, ubi-vehicles, ubi-drivers',
    run: safety,
    service: 'safety grades',
  },
  {
    name: 'maintenance',
    args: [{ name: '<plate>', required: false }],
    flags: {
      types: {
        type: 'boolean',
        summary: 'The kinds of treatment this account records',
      },
      limit: LIMIT,
      full: FULL,
    },
    summary: 'Maintenance records and schedules',
    run: maintenance,
    service: 'maintenance',
  },
  {
    name: 'temps',
    args: [
      { name: '<view>', required: false },
      { name: '<plate>', required: false },
    ],
    flags: { ...WINDOW, limit: LIMIT, full: FULL },
    summary: 'Temperature sensors (ITC): current, history <plate>, breaches',
    run: temps,
    service: 'temperature sensors (ITC)',
  },
  {
    name: 'logout',
    args: [],
    flags: {},
    summary: 'Delete the cached sign-in token',
    run: logout,
  },
  {
    name: 'help',
    args: [{ name: '<command>', required: false }],
    flags: {},
    summary: 'List the commands, or show one command',
    run: async () => '',
  },
];

async function logout(
  input: Parameters<CommandSpec['run']>[0],
): Promise<string> {
  const settings = readSettings(input.io.env);
  if (!settings.auth || settings.auth.kind === 'token') {
    return render({
      signed_out: false,
      reason: 'No cached token: ITURAN_TOKEN is used as it is.',
    });
  }
  const existed = forgetToken(settings, settings.auth.user, input.io.env);
  return render({
    signed_out: existed,
    reason: existed ? 'The cached token was deleted.' : 'No token was cached.',
  });
}

const HOME = COMMANDS[0] as Spec;
const HELP_FLAGS = new Set(['--help', '-h']);
const VERSION_FLAGS = new Set(['--version', '-v', '-V']);

export function topHelp(): string {
  return `${encode({
    description: DESCRIPTION,
    usage: `${BIN} [command] [flags]`,
    commands: COMMANDS.map((c) => ({
      command: commandName(c),
      summary: c.summary,
    })),
    settings:
      'ITURAN_TOKEN, or ITURAN_USERNAME and ITURAN_PASSWORD; ITURAN_URL (default https://api.ituran.com/api/v2)',
  })}\n${helpBlock([`Run \`${BIN} help <command>\` for its flags`])}`;
}

export function commandHelp(spec: CommandSpec): string {
  const flags = Object.entries(spec.flags).map(([name, f]) => ({
    flag:
      f.type === 'string' ? `--${name} ${f.value ?? '<value>'}` : `--${name}`,
    summary: f.multiple ? `${f.summary} (repeatable)` : f.summary,
  }));
  return `${encode({
    command: commandName(spec),
    summary: spec.summary,
    usage: usageLine(spec),
    ...(flags.length ? { flags } : {}),
  })}\n`;
}

function find(name: string): Spec | undefined {
  return COMMANDS.find((c) => c.name === name && c.name !== '');
}

function unknownCommand(name: string): AxiError {
  const shown = /^[a-z][a-z-]{0,30}$/.test(name)
    ? `\`${name}\``
    : 'that command';
  const list = COMMANDS.filter((c) => c.name).map((c) => c.name);
  return usage(`Unknown command ${shown}. Commands: ${list.join(', ')}.`);
}

const NOT_HERE = new Set(['not_entitled', 'feature_off', 'needs_app_id']);

/** Record, for the home view, whether this command's service answered. */
function remember(spec: Spec, io: Io, error: AxiError | null): void {
  if (!spec.service) return;
  try {
    const dir = cacheDir(connected(io.env), io.env);
    if (error && NOT_HERE.has(error.code))
      noteUnavailable(dir, spec.service, error.code);
    else if (!error) noteAvailable(dir, spec.service);
  } catch {
    /* settings missing: nothing to remember */
  }
}

export async function main(argv: string[], io: Io): Promise<number> {
  let spec: Spec = HOME;
  let usageText = `${BIN} [command] [flags]`;
  try {
    const first = argv[0];
    if (argv.length === 1 && first && VERSION_FLAGS.has(first)) {
      io.stdout(`${VERSION}\n`);
      return 0;
    }
    if (argv.length === 1 && first && HELP_FLAGS.has(first)) {
      io.stdout(topHelp());
      return 0;
    }
    let rest = argv;
    if (first && !first.startsWith('-')) {
      const found = find(first);
      if (!found) throw unknownCommand(first);
      spec = found;
      rest = argv.slice(1);
    }
    usageText = usageLine(spec);
    const beforeTerminator = rest.includes('--')
      ? rest.slice(0, rest.indexOf('--'))
      : rest;
    if (beforeTerminator.some((a) => HELP_FLAGS.has(a))) {
      io.stdout(commandHelp(spec));
      return 0;
    }
    const parsed = parseCommand(spec, rest);
    if (spec.name === 'help') {
      const target = parsed.positionals[0];
      if (!target) {
        io.stdout(topHelp());
        return 0;
      }
      const found = find(target);
      if (!found) throw unknownCommand(target);
      io.stdout(commandHelp(found));
      return 0;
    }
    const out = await spec.run({ ...parsed, io });
    remember(spec, io, null);
    io.stdout(out);
    return 0;
  } catch (error) {
    const axi =
      error instanceof AxiError
        ? error
        : new AxiError(
            'internal_error',
            'ituran-axi failed unexpectedly. Run the command once more; if it fails again, report it.',
          );
    remember(spec, io, axi);
    io.stdout(errorText(axi, usageText));
    return axi.exitCode;
  }
}
