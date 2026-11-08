import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
