import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { joinedRows, type Page } from '../../src/commands/common.ts';
import { readSettings } from '../../src/config.ts';
import { type AxiError, classify } from '../../src/errors.ts';
import { isRead } from '../../src/http.ts';
import { parseJson } from '../../src/json.ts';
import { Pace } from '../../src/pace.ts';
import { normalizePlate } from '../../src/plates.ts';
import {
  age,
  hoursMinutes,
  localTime,
  splitWindow,
  windowOf,
  zoneOf,
} from '../../src/time.ts';

const NOW = new Date('2026-11-08T10:00:00Z'); // 12:00 in Asia/Jerusalem
const ZONE = 'Asia/Jerusalem';
const answer = (
  status: number,
  json?: unknown,
  headers: Record<string, string> = {},
) => ({
  status,
  headers: new Headers(headers),
  json,
  bytes: 0,
  ms: 0,
});

describe('time', () => {
  it('maps Windows zone names and falls back to UTC', () => {
    assert.equal(zoneOf('Israel Standard Time'), 'Asia/Jerusalem');
    assert.equal(zoneOf('Europe/Paris'), 'Europe/Paris');
    assert.equal(zoneOf('No Such Standard Time'), 'UTC');
  });

  it('builds windows in local time, ending two minutes ago', () => {
    assert.equal(localTime(NOW, ZONE), '2026-11-08T12:00:00');
    assert.deepEqual(windowOf({ since: '24h' }, ZONE, NOW, '7d'), {
      from: '2026-11-07T12:00:00',
      to: '2026-11-08T11:58:00',
    });
    assert.deepEqual(windowOf({ date: '2026-11-07' }, ZONE, NOW, '7d'), {
      from: '2026-11-07T00:00:00',
      to: '2026-11-07T23:59:59',
    });
    assert.deepEqual(
      windowOf({ from: '2026-11-01', to: '2026-11-02T08:30' }, ZONE, NOW, '7d'),
      { from: '2026-11-01T00:00:00', to: '2026-11-02T08:30:00' },
    );
    // Today is clamped to now, and date-only routes get dates.
    assert.deepEqual(
      windowOf({ date: '2026-11-08' }, ZONE, NOW, '7d', 'date'),
      { from: '2026-11-08', to: '2026-11-08' },
    );
    assert.deepEqual(windowOf({}, ZONE, NOW, '7d', 'date'), {
      from: '2026-11-01',
      to: '2026-11-08',
    });
  });

  it('refuses windows that make no sense', () => {
    assert.throws(
      () => windowOf({ since: '24h', date: '2026-11-07' }, ZONE, NOW, '7d'),
      /one of --since/,
    );
    assert.throws(
      () => windowOf({ to: '2026-11-07' }, ZONE, NOW, '7d'),
      /--to needs --from/,
    );
    assert.throws(
      () => windowOf({ since: '3w' }, ZONE, NOW, '7d'),
      /90m, 24h or 7d/,
    );
    assert.throws(
      () => windowOf({ from: '2026-11-09' }, ZONE, NOW, '7d'),
      /future/,
    );
    assert.throws(
      () => windowOf({ date: '2026-13-01' }, ZONE, NOW, '7d'),
      /not a date/,
    );
  });

  it('reads both duration forms and ages', () => {
    assert.equal(hoursMinutes('P2DT20H37M33S'), '68:38');
    assert.equal(hoursMinutes('05:38:35'), '5:39');
    assert.equal(hoursMinutes(1800), '0:30');
    assert.equal(hoursMinutes(4, 'minutes'), '0:04');
    assert.equal(hoursMinutes('soon'), null);
    assert.equal(age('2026-11-08T11:57:00', NOW, ZONE), '3m');
    assert.equal(age('2026-11-08T09:00:00.120', NOW, ZONE), '3h');
    assert.equal(age('2026-11-01T12:00:00', NOW, ZONE), '7d');
  });
});

describe('long windows', () => {
  it('cuts a window into week spans, newest first, without overlap', () => {
    const month = splitWindow(
      { from: '2026-10-08T00:00:00', to: '2026-11-07T23:59:59' },
      7,
    );
    assert.deepEqual(month, [
      { from: '2026-11-01T00:00:00', to: '2026-11-07T23:59:59' },
      { from: '2026-10-25T00:00:00', to: '2026-10-31T23:59:59' },
      { from: '2026-10-18T00:00:00', to: '2026-10-24T23:59:59' },
      { from: '2026-10-11T00:00:00', to: '2026-10-17T23:59:59' },
      { from: '2026-10-08T00:00:00', to: '2026-10-10T23:59:59' },
    ]);
    const week = { from: '2026-11-01T00:00:00', to: '2026-11-07T23:59:59' };
    assert.deepEqual(splitWindow(week, 7), [week]);
    const day = { from: '2026-11-07T08:15:00', to: '2026-11-07T09:00:00' };
    assert.deepEqual(splitWindow(day, 7), [day]);
    const odd = splitWindow(
      { from: '2026-10-31T10:00:00', to: '2026-11-07T10:00:00' },
      7,
    );
    assert.deepEqual(odd, [
      { from: '2026-10-31T10:00:01', to: '2026-11-07T10:00:00' },
      { from: '2026-10-31T10:00:00', to: '2026-10-31T10:00:00' },
    ]);
  });

  it('reads several lists as one, fetching only the pages it needs', async () => {
    const calls: string[] = [];
    const list =
      (name: string, count: number) =>
      async (pageNumber: number, pageSize: number): Promise<Page> => {
        calls.push(`${name}${pageNumber}/${pageSize}`);
        const ids = Array.from({ length: count }, (_, i) => `${name}${i}`);
        return {
          rows: ids
            .slice((pageNumber - 1) * pageSize, pageNumber * pageSize)
            .map((id) => ({ id })),
          total: count,
        };
      };
    const ids = (page: Page) => page.rows.map((r) => r.id).join(' ');
    const lists = () => [list('a', 12), list('b', 0), list('c', 25)];

    const first = await joinedRows(lists(), 1, 20);
    assert.equal(first.total, 37);
    assert.equal(
      ids(first),
      'a0 a1 a2 a3 a4 a5 a6 a7 a8 a9 a10 a11 c0 c1 c2 c3 c4 c5 c6 c7',
    );
    assert.deepEqual(calls.splice(0), ['a1/20', 'b1/10', 'c1/10']);

    const second = await joinedRows(lists(), 2, 20);
    assert.equal(
      ids(second),
      Array.from({ length: 17 }, (_, i) => `c${i + 8}`).join(' '),
    );
    assert.deepEqual(calls.splice(0), [
      'a1/10',
      'b1/10',
      'c1/10',
      'c1/20',
      'c2/20',
    ]);

    const small = await joinedRows(lists(), 3, 5);
    assert.equal(ids(small), 'a10 a11 c0 c1 c2');
    assert.deepEqual(calls.splice(0), ['a1/10', 'b1/10', 'c1/10', 'a2/10']);

    const past = await joinedRows(lists(), 9, 5);
    assert.deepEqual(past, { rows: [], total: 37 });

    const one = await joinedRows([list('a', 12)], 2, 5);
    assert.equal(ids(one), 'a5 a6 a7 a8 a9');
  });

  it('refuses a page with no count that might not be the last', async () => {
    const full = async (_n: number, size: number): Promise<Page> => ({
      rows: Array.from({ length: size }, (_, i) => ({ id: i })),
      total: null,
    });
    const short = async (): Promise<Page> => ({
      rows: [{ id: 1 }],
      total: null,
    });
    assert.equal((await joinedRows([short, short], 1, 20)).total, 2);
    await assert.rejects(joinedRows([full, short], 1, 20), (e: AxiError) => {
      assert.equal(e.code, 'ituran_error');
      return true;
    });
  });
});

describe('json, plates and settings', () => {
  it('keeps integers above 2^53 exact', () => {
    const v = parseJson(
      '{"code":3816028517986434181,"n":42,"s":"12345678901234567890","f":1.5e300}',
    ) as Record<string, unknown>;
    assert.equal(v.code, '3816028517986434181');
    assert.equal(v.n, 42);
    assert.equal(v.s, '12345678901234567890');
  });

  it('normalizes plates and refuses what cannot be one', () => {
    assert.equal(normalizePlate('12-345-678'), '12345678');
    assert.equal(normalizePlate(' ab 12 '), 'AB12');
    assert.throws(
      () => normalizePlate('../x'),
      (e: AxiError) => e.code === 'usage',
    );
    assert.throws(
      () => normalizePlate('12%2F34'),
      (e: AxiError) => e.code === 'usage',
    );
  });

  it('defaults to production and derives identity', () => {
    const s = readSettings({});
    assert.equal(s.url, 'https://api.ituran.com/api/v2');
    assert.equal(s.identity, 'https://api.ituran.com/api/v1');
    assert.equal(s.auth, undefined);
    assert.equal(
      readSettings({
        ITURAN_GLOBAL_BASE_URL: 'https://api-qa.ituran.com/api/v2/',
      }).url,
      'https://api-qa.ituran.com/api/v2',
    );
    assert.deepEqual(
      readSettings({
        ITURAN_TOKEN: 't',
        ITURAN_USERNAME: 'u',
        ITURAN_PASSWORD: 'p',
      }).auth,
      { kind: 'token', token: 't' },
    );
  });

  it('refuses unsafe or malformed settings', () => {
    assert.throws(
      () => readSettings({ ITURAN_URL: 'http://api.ituran.com/api/v2' }),
      /https/,
    );
    assert.throws(
      () => readSettings({ ITURAN_URL: 'https://api.ituran.com/' }),
      /API root/,
    );
    assert.throws(
      () => readSettings({ COMIS_DEADLINE: 'soon' }),
      (e: AxiError) => e.code === 'usage',
    );
    assert.equal(
      readSettings({ COMIS_DEADLINE: '1762600000000' }).deadline,
      1762600000000,
    );
  });
});

describe('errors', () => {
  it('maps Ituran and Gate answers to the closed set', () => {
    const code = (
      status: number,
      json?: unknown,
      headers?: Record<string, string>,
      ctx = {},
    ) => classify(answer(status, json, headers), ctx)?.code;
    assert.equal(code(200, {}), undefined);
    assert.equal(
      code(502, undefined, { 'comis-refusal': 'reconnect_needed' }),
      'reconnect_needed',
    );
    assert.equal(
      code(403, undefined, { 'comis-refusal': 'destination_refused' }),
      'refused',
    );
    // The Gate signing in to Ituran for a password-exchange connection.
    const waiting = classify(
      answer(503, undefined, { 'comis-refusal': 'unavailable' }),
    );
    assert.equal(waiting?.code, 'refused');
    assert.match(String(waiting?.message), /signing in to Ituran/);
    assert.equal(code(474), 'access_blocked');
    assert.equal(code(401, { error_code: '401' }), 'auth_failed');
    assert.equal(
      code(403, {
        error_code: '1020',
        error_description: 'Platform not belong to user',
      }),
      'not_visible',
    );
    assert.equal(code(403, { error_code: '1006' }), 'not_entitled');
    assert.equal(code(403), 'not_entitled');
    assert.equal(
      code(403, {
        error_code: '403.2',
        error_description: 'feature is not enabled',
      }),
      'feature_off',
    );
    assert.equal(
      code(400, { error_code: '400', errors: [{ error_code: '1032' }] }),
      'needs_app_id',
    );
    assert.equal(
      code(404, { error_code: '404.1' }, {}, { trips: true }),
      'not_tracked',
    );
    assert.equal(code(404, { error_code: '404' }), 'not_found');
    assert.equal(code(481), 'rate_limited');
    assert.equal(
      code(400, {
        error_code: '400',
        errors: [{ error_code: '1000', error_description: 'bad' }],
      }),
      'rejected',
    );
    assert.equal(code(500, { error_description: 'boom' }), 'ituran_error');
  });

  it("keeps Ituran's words for a rejected request", () => {
    const e = classify(
      answer(400, {
        error_code: '400',
        error_description: 'One or more validation errors occurred.',
        errors: [
          {
            error_code: '1000',
            error_description:
              'to_date = date should be only date without time.',
          },
        ],
      }),
    );
    assert.match(String(e?.message), /date should be only date without time/);
    assert.equal(e?.fields.codes, '400 1000');
  });
});

describe('http', () => {
  const s = readSettings({});
  it('sends only reads', () => {
    assert.equal(isRead(s, 'GET', '/api/v2/vehicles'), true);
    assert.equal(isRead(s, 'GET', '/api/v1/temperatures/current'), true);
    assert.equal(isRead(s, 'POST', '/api/v2/vehicles/search'), true);
    assert.equal(isRead(s, 'POST', '/api/v2/reports/bi/daily/vehicles'), true);
    assert.equal(isRead(s, 'POST', '/api/v2/places'), false);
    assert.equal(isRead(s, 'POST', '/api/v2/commands/send'), false);
    assert.equal(isRead(s, 'PUT', '/api/v2/alerts/1'), false);
    assert.equal(isRead(s, 'DELETE', '/api/v2/places/1'), false);
    assert.equal(isRead(s, 'GET', '/api/v1/oauth/token'), false);
    assert.equal(isRead(s, 'GET', '/api/v2/../v1/oauth/token'), false);
    assert.equal(isRead(s, 'GET', '/api/v2/vehicles/12%2F34'), false);
  });

  it('paces requests: two at a time, starts 400 ms apart', async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const pace = new Pace(
      async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      () => clock,
    );
    let active = 0;
    let most = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        pace.run(async () => {
          active++;
          most = Math.max(most, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    assert.ok(most <= 2, `at most 2 in flight, saw ${most}`);
    assert.ok(
      sleeps.length >= 4 && sleeps.every((ms) => ms > 0),
      JSON.stringify(sleeps),
    );
  });
});
