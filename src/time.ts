// Ituran speaks naive local time: "2026-11-08T09:30:00" in the account's own
// zone, with no offset. users/me names that zone with a Windows id. Windows
// are built here in the account's zone and in the form each route takes.

import { usage } from './errors.ts';

const WINDOWS_ZONES: Record<string, string> = {
  'Israel Standard Time': 'Asia/Jerusalem',
  UTC: 'UTC',
  'GMT Standard Time': 'Europe/London',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kiev',
  'GTB Standard Time': 'Europe/Bucharest',
  'Russian Standard Time': 'Europe/Moscow',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Central Standard Time (Mexico)': 'America/Mexico_City',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'Argentina Standard Time': 'America/Buenos_Aires',
  'SA Pacific Standard Time': 'America/Bogota',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'India Standard Time': 'Asia/Kolkata',
  'Mid-Atlantic Standard Time': 'Etc/GMT+2',
};

/** An IANA zone for a Windows or IANA name, or UTC when it is unknown. */
export function zoneOf(name: string | undefined): string {
  if (!name) return 'UTC';
  const candidate = WINDOWS_ZONES[name] ?? name;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: candidate });
    return candidate;
  } catch {
    return 'UTC';
  }
}

/** The wall clock in `zone` at `at`, as a naive ISO string. */
export function localTime(at: Date, zone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

const NAIVE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/;

/** Milliseconds for a naive time, read as if it were UTC: only for differences. */
export function naiveMs(text: string): number | null {
  const m = NAIVE.exec(text);
  if (!m) return null;
  const [, y = '', mo = '', d = '', h = '0', mi = '0', s = '0'] = m;
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  // Date.UTC rolls 2026-13-01 over to 2027-01-01; an impossible date is no date.
  const back = new Date(ms);
  if (
    !Number.isFinite(ms) ||
    back.getUTCMonth() !== +mo - 1 ||
    back.getUTCDate() !== +d ||
    +h > 23 ||
    +mi > 59 ||
    +s > 59
  ) {
    return null;
  }
  return ms;
}

function naiveFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19);
}

/** Minutes in "90m", "24h" or "7d". */
export function parseSpan(text: string, flag: string): number {
  const m = /^([1-9][0-9]{0,4})([mhd])$/.exec(text);
  if (!m) throw usage(`--${flag} takes a span such as 90m, 24h or 7d.`);
  const n = Number(m[1]);
  return n * (m[2] === 'm' ? 1 : m[2] === 'h' ? 60 : 1440);
}

export interface WindowFlags {
  since?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  date?: string | undefined;
}

export interface Window {
  /** Naive local, or date-only when the route takes dates. */
  from: string;
  to: string;
}

/** Ituran refuses windows that end in the future; this keeps a safe margin. */
const NOW_MARGIN_MIN = 2;

function readTime(text: string, flag: string, end: boolean): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    if (naiveMs(text) === null) throw usage(`--${flag} is not a date.`);
    return `${text}T${end ? '23:59:59' : '00:00:00'}`;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(text)) {
    if (naiveMs(text) === null) throw usage(`--${flag} is not a time.`);
    return text.length === 16 ? `${text}:00` : text;
  }
  throw usage(
    `--${flag} takes YYYY-MM-DD or YYYY-MM-DDTHH:mm, local to the account.`,
  );
}

/**
 * The window the flags describe, in the account's zone. `fallback` is the
 * span used when no flag is given. With form "date" the bounds are dates.
 */
export function windowOf(
  flags: WindowFlags,
  zone: string,
  now: Date,
  fallback: string,
  form: 'naive' | 'date' = 'naive',
): Window {
  const given = [flags.since, flags.from, flags.date].filter(Boolean).length;
  if (given > 1)
    throw usage('Use one of --since, --from or --date, not several.');
  if (flags.to && !flags.from) throw usage('--to needs --from.');
  const nowLocal = localTime(now, zone);
  const nowMs = naiveMs(nowLocal) as number;
  const latest = naiveFromMs(nowMs - NOW_MARGIN_MIN * 60_000);
  let from: string;
  let to: string;
  if (flags.date) {
    from = readTime(flags.date, 'date', false);
    to = readTime(flags.date, 'date', true);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(flags.date))
      throw usage('--date takes YYYY-MM-DD.');
  } else if (flags.from) {
    from = readTime(flags.from, 'from', false);
    to = flags.to ? readTime(flags.to, 'to', true) : latest;
  } else {
    const minutes = parseSpan(flags.since ?? fallback, 'since');
    from = naiveFromMs(nowMs - minutes * 60_000);
    to = latest;
  }
  if ((naiveMs(to) as number) > nowMs - NOW_MARGIN_MIN * 60_000) to = latest;
  if ((naiveMs(from) as number) > (naiveMs(to) as number)) {
    throw usage('The window starts after it ends, or lies in the future.');
  }
  if (form === 'date') return { from: from.slice(0, 10), to: to.slice(0, 10) };
  return { from, to };
}

/** How long ago a naive local time was: "3m", "2h", "5d", or null. */
export function age(
  timestamp: unknown,
  now: Date,
  zone: string,
): string | null {
  if (typeof timestamp !== 'string') return null;
  const then = naiveMs(timestamp);
  if (then === null) return null;
  const minutes = Math.round(
    ((naiveMs(localTime(now, zone)) as number) - then) / 60_000,
  );
  if (minutes < 0) return 'future';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

/** Minutes in a naive-time age string, for --stale comparisons. */
export function ageMinutes(
  timestamp: unknown,
  now: Date,
  zone: string,
): number | null {
  if (typeof timestamp !== 'string') return null;
  const then = naiveMs(timestamp);
  if (then === null) return null;
  return Math.round(
    ((naiveMs(localTime(now, zone)) as number) - then) / 60_000,
  );
}

/**
 * A duration as h:mm, from Ituran's two forms (ISO 8601 such as P2DT3H4M5S,
 * or a clock such as 05:38:35) or from seconds.
 */
export function hoursMinutes(
  value: unknown,
  unit: 'seconds' | 'minutes' = 'seconds',
): string | null {
  let seconds: number | null = null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    seconds = unit === 'minutes' ? value * 60 : value;
  } else if (typeof value === 'string') {
    const iso =
      /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
        value,
      );
    const clock = /^(\d{1,4}):(\d{2}):(\d{2})$/.exec(value);
    if (iso && value !== 'P' && value !== 'PT') {
      seconds =
        +(iso[1] ?? 0) * 86400 +
        +(iso[2] ?? 0) * 3600 +
        +(iso[3] ?? 0) * 60 +
        +(iso[4] ?? 0);
    } else if (clock) {
      seconds =
        Number(clock[1] ?? 0) * 3600 +
        Number(clock[2] ?? 0) * 60 +
        Number(clock[3] ?? 0);
    }
  }
  if (seconds === null || seconds < 0) return null;
  const total = Math.round(seconds / 60);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
