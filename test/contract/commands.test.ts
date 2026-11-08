// The real binary, as a separate process, against the fake Ituran.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { decode } from '@toon-format/toon';
import { READ_POSTS } from '../../src/http.ts';
import { startFake } from '../fake/ituran-fake.ts';
import { fakeEnv, runBinary } from '../helpers.ts';

let fake: Awaited<ReturnType<typeof startFake>>;
let env: Record<string, string>;
before(async () => {
  fake = await startFake();
  env = fakeEnv(fake.url);
});
after(() => fake.close());

const run = (...args: string[]) => runBinary(args, env);

/** The encoded TOON body, without the AXI help footer. */
function doc(text: string): Record<string, unknown> {
  const [encoded = ''] = text.split(/^help\[\d+\]:\n/m);
  return decode(encoded) as Record<string, unknown>;
}
const summary = (text: string) => String(doc(text).summary);
async function ok(...args: string[]): Promise<string> {
  const r = await run(...args);
  assert.equal(r.code, 0, `${args.join(' ')}\n${r.stdout}`);
  assert.equal(r.stderr, '', args.join(' '));
  return r.stdout;
}
async function fails(
  code: number,
  errorCode: string,
  ...args: string[]
): Promise<string> {
  const r = await run(...args);
  assert.equal(r.code, code, `${args.join(' ')}\n${r.stdout}`);
  assert.match(r.stdout, new RegExp(`^code: ${errorCode}$`, 'm'), r.stdout);
  return r.stdout;
}

describe('ituran-axi against the fake', () => {
  it('shows the home view', async () => {
    const out = await ok();
    assert.equal(doc(out).account, 'Example Ltd · user user_a (Manager)');
    assert.equal(doc(out).zone, 'Asia/Jerusalem (Israel Standard Time)');
    assert.equal(doc(out).vehicles, 13);
    assert.match(out, /^help\[3\]:$/m);
  });

  it('lists and finds vehicles', async () => {
    assert.match(summary(await ok('vehicles')), /^13 vehicles$/);
    const page = await ok('vehicles', '--limit', '3', '--page', '4');
    assert.match(summary(page), /^3 of 13 vehicles, page 4$/);
    assert.match(
      page,
      /Run `ituran-axi vehicles --page 5 --limit 3` for the next 1/,
    );
    assert.match(
      summary(await ok('vehicles', '1234')),
      /^\d+ vehicles? with 1234 in the plate$/,
    );
    assert.match(
      summary(await ok('vehicles', 'Van')),
      /^\d+ vehicles named like "Van"$/,
    );
    assert.match(
      summary(await ok('vehicles', 'Corolla')),
      /^\d+ vehicles matching "Corolla" by make, model or color$/,
    );
    assert.match(
      summary(await ok('vehicles', 'nothing-like-it')),
      /^0 vehicles/,
    );
    const rt = await ok(
      'vehicles',
      '--fields',
      'plate,address,driver',
      '--limit',
      '2',
    );
    assert.match(rt, /vehicles\[2\]\{plate,address,driver\}:/);
    assert.match(rt, /Example Street/);
  });

  it('shows one vehicle with its position, driver and places', async () => {
    const out = await ok('vehicle', '12-345-678');
    assert.equal(doc(out).plate, '12345678');
    assert.equal(
      (doc(out).position as Record<string, unknown>).address,
      '0 Example Street, Tel Aviv',
    );
    assert.equal(
      (doc(out).driver as Record<string, unknown>).name,
      'Driver D0',
    );
    assert.deepEqual(doc(out).places, ['Depot']);
    assert.doesNotMatch(out, /050-0000000|VIN0/);
    assert.match(
      await ok('vehicle', '12345678', '--full'),
      /phone: 050-0000000/,
    );
    await fails(1, 'not_found', 'vehicle', '00000000');
    await fails(2, 'usage', 'vehicle', '../etc');
  });

  it('shows where every vehicle is, with counts and stale positions', async () => {
    const all = await ok('where', '--all');
    assert.match(
      summary(all),
      /^13 vehicles · \d+ parking · \d+ driving · 1 last seen over 24h ago$/,
    );
    const stale = await ok('where', '--stale', '24h');
    assert.equal(doc(stale).listed, '1 last seen over 24h ago');
    assert.match(stale, /vehicles\[1\]/);
    const two = await ok('where', '12345678', '23456789', '00000001');
    assert.equal(doc(two).not_found, '00000001');
    assert.match(two, /vehicles\[2\]/);
  });

  it('lists trips in a window and shows one trip', async () => {
    const day = await ok('trips', '12345678', '--date', '2026-11-07');
    assert.match(summary(day), /^12 trips for 12345678 · 150 km$/);
    assert.equal(doc(day).window, '2026-11-07T00:00:00 to 2026-11-07T23:59:59');
    assert.match(day, /trips\[12\]\{id,start,end,km,driver\}:/);
    assert.match(
      summary(
        await ok('trips', '12345678', '--date', '2026-11-07', '--limit', '5'),
      ),
      /^5 of 12 trips for 12345678$/,
    );
    const none = await ok('trips', '--date', '2026-11-01');
    assert.match(summary(none), /^0 trips for all vehicles$/);
    assert.match(
      String(doc(none).note),
      /^Ituran matches trips by their end time/,
    );
    await fails(1, 'not_tracked', 'trips', '99887766', '--date', '2026-11-07');
    const trip = await ok('trip', '5000', '--points', '--limit', '20');
    assert.equal(
      doc(trip).points_summary,
      '14 of 15 points; 1 without a GPS fix left out',
    );
    assert.equal(doc(trip).duration, '0:30');
    await fails(1, 'not_found', 'trip', '1');
  });

  it('shows totals with the right date forms', async () => {
    const all = await ok('totals', '--date', '2026-11-07');
    assert.equal(doc(all).trips, 40);
    assert.equal(doc(all).driving, '26:03');
    assert.match(
      await ok('totals', '12345678', '--date', '2026-11-07'),
      /^periods\[1\]/m,
    );
  });

  it('lists drivers, keeping large codes exact and phones out', async () => {
    const list = await ok('drivers', '--limit', '25', '--fields', 'id,code');
    assert.match(list, /3816028517986434181/);
    assert.match(summary(await ok('drivers')), /^20 of 25 drivers$/);
    assert.match(
      summary(await ok('drivers', 'דנה')),
      /^1 driver matching "דנה"$/,
    );
    assert.doesNotMatch(await ok('driver', '500'), /050-0000000|example\.com/);
  });

  it('finds places by name and the vehicles in one now', async () => {
    const found = await ok('places', 'depot');
    assert.match(summary(found), /^1 saved place matching "depot"$/);
    assert.equal(doc(found).index, 'built now: 14 places');
    assert.match(summary(await ok('places', 'מחסן')), /^1 saved place/);
    assert.equal(
      doc(await ok('place', '77', '--vehicles')).vehicles_summary,
      '3 of 13 vehicles are in this place now',
    );
    await fails(1, 'not_found', 'place', '4242');
  });

  it('reads groups, events and alerts', async () => {
    assert.match(summary(await ok('groups')), /^2 vehicle groups$/);
    const events = await ok('events');
    assert.match(
      summary(events),
      /^3 event states · 2 with vehicles in them now$/,
    );
    assert.match(await ok('events', '--all'), /ניתוק {2}מתח/);
    assert.match(
      summary(await ok('event', '11')),
      /^3 vehicles in event state 11 now$/,
    );
    assert.match(
      summary(await ok('alerts')),
      /^2 alert definitions · 1 repeated rows removed$/,
    );
  });

  it('reads diagnostics, odometers and maintenance', async () => {
    assert.match(await ok('diagnostics', '12345678'), /Diagnostic_60/);
    assert.match(
      summary(await ok('odometer', '12345678', '23456789')),
      /^2 of 2 vehicles have a GPS odometer estimate/,
    );
    assert.match(
      summary(await ok('maintenance')),
      /^0 treatment records: this account keeps no maintenance records/,
    );
    assert.match(
      summary(await ok('maintenance', '--types')),
      /^2 treatment types$/,
    );
  });

  it('runs reports, splitting and following the cursor', async () => {
    assert.match(
      summary(
        await ok('report', 'daily', '--date', '2026-11-07', '--limit', '3'),
      ),
      /^3 of 12 rows of the daily report by vehicle$/,
    );
    const idle = await ok(
      'report',
      'idle',
      '--date',
      '2026-11-07',
      '--limit',
      '3',
    );
    assert.match(summary(idle), /^3 of 12 rows of the idle report by vehicle$/);
    assert.deepEqual(doc(idle).total, {
      vehicles: 12,
      drivers: 9,
      km: 660,
      driving: '12:24',
      idle: '1:00',
    });
    await fails(2, 'usage', 'report', 'daily', '--limit', '1001');
    const filtered = await ok(
      'report',
      'daily',
      '12345678',
      '--date',
      '2026-11-07',
    );
    assert.match(summary(filtered), /^1 row of the daily report by vehicle$/);
    assert.match(String(doc(filtered).note), /^Ituran ignores plate filters/);
    const events = await ok(
      'report',
      'events',
      '12345678',
      '--date',
      '2026-11-07',
    );
    assert.match(
      summary(events),
      /^7 records of the events report for 12345678$/,
    );
    assert.equal((events.match(/Report Road 3/g) ?? []).length, 7);
    assert.match(
      await ok(
        'report',
        'events',
        '12345678',
        '--date',
        '2026-11-07',
        '--limit',
        '3',
      ),
      /more exist/,
    );
    await fails(2, 'usage', 'report', 'speed', '12345678');
    await fails(2, 'usage', 'report', 'events');
    await fails(2, 'usage', 'report', 'heat-map', '12345678', '23456789');
    await fails(2, 'usage', 'report', 'nosuch');
  });

  it('reads safety grades', async () => {
    assert.match(
      summary(await ok('safety', '--date', '2026-11-07')),
      /^safety grade 71 · fuel grade 64 · 8 safety events$/,
    );
    assert.match(
      summary(await ok('safety', 'vehicles', '--date', '2026-11-07')),
      /^4 rows of safety vehicles$/,
    );
  });

  it('answers "near a point" and "nearest" questions locally', async () => {
    // Vehicle i stands at 32.08 + i/100, 34.78; this point is vehicle 2's.
    const near = await ok('where', '--near', '32.10,34.78', '--within', '1.2');
    const rows = doc(near).vehicles as Record<string, unknown>[];
    assert.deepEqual(
      rows.map((r) => r.plate),
      ['34567890', '23456789', '45678901'],
    );
    assert.equal(rows[0]?.km, 0);
    assert.match(
      String(doc(near).listed),
      /^3 within 1\.2 km of 32\.1,34\.78$/,
    );
    await fails(2, 'usage', 'where', '--within', '5');
    await fails(2, 'usage', 'where', '--near', 'north');
    const centers = await ok('centers', '--near', '12345678');
    const list = doc(centers).centers as Record<string, unknown>[];
    assert.equal(list[0]?.name, 'Tel Aviv Center');
    assert.match(
      String(doc(centers).from),
      /^12345678, last seen \d+[mhd] ago$/,
    );
    assert.match(summary(await ok('centers')), /^3 Ituran service centers$/);
  });

  it("reads every vehicle's diagnostics, and new columns", async () => {
    const all = await ok('diagnostics', '--all', '--limit', '50');
    assert.match(summary(all), /^9 latest readings from 9 of 13 vehicles/);
    await fails(2, 'usage', 'diagnostics');
    await fails(2, 'usage', 'diagnostics', '12345678', '--all');
    const years = await ok(
      'vehicles',
      '--fields',
      'plate,make,year',
      '--limit',
      '4',
    );
    const rows = doc(years).vehicles as Record<string, unknown>[];
    assert.deepEqual(rows[3], { plate: '45678901', make: 'Ford', year: null });
    assert.equal(rows[0]?.year, 2022);
    const trip = await ok(
      'trips',
      '12345678',
      '--date',
      '2026-11-07',
      '--fields',
      'id,start_lat,end_lon',
      '--limit',
      '1',
    );
    assert.deepEqual((doc(trip).trips as unknown[])[0], {
      id: 5000,
      start_lat: 32,
      end_lon: 34.9,
    });
  });

  it('reads safety by group and by month', async () => {
    const groups = await ok('safety', 'groups', '--date', '2026-11-07');
    assert.match(
      summary(groups),
      /^2 of 3 groups have safety data; 1 have none/,
    );
    // Ituran counts any time today as the future here, so windows end yesterday.
    const groupsWeek = await ok('safety', 'groups');
    assert.match(summary(groupsWeek), /^2 of 3 groups have safety data/);
    assert.match(String(doc(groupsWeek).window), /up to yesterday/);
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Jerusalem',
    }).format(new Date());
    await fails(2, 'usage', 'safety', 'groups', '--date', today);
    const monthly = await ok(
      'safety',
      'periodic',
      '--by',
      'month',
      '--from',
      '2026-09-01',
      '--to',
      '2026-10-31',
    );
    assert.match(monthly, /2026-09/);
    await fails(2, 'usage', 'safety', 'totals', '--by', 'month');
    await fails(2, 'usage', 'safety', 'periodic', '--by', 'week');
  });

  it('pages drivers at most 1,000 at a time', async () => {
    assert.match(
      summary(await ok('drivers', '--limit', '1000')),
      /^25 drivers$/,
    );
    await fails(2, 'usage', 'drivers', '--limit', '1001');
    assert.match(summary(await ok('drivers', 'דנה')), /driver/);
  });

  it('names a service the account lacks, and the home view remembers it', async () => {
    await fails(1, 'not_entitled', 'temps');
    assert.equal(
      doc(await ok()).not_on_this_account,
      'temperature sensors (ITC)',
    );
  });

  it('refuses bad usage with exit 2', async () => {
    await fails(2, 'usage', 'frobnicate');
    await fails(2, 'usage', 'vehicles', '--bogus');
    await fails(2, 'usage', 'trips', '--since', '3w');
    await fails(2, 'usage', 'where', '12345678', '--all');
  });

  it('sent only reads, and signed in once for every command above', () => {
    const reqs = fake.state.requests;
    assert.ok(reqs.length > 40);
    for (const r of reqs) {
      if (r.path === '/api/v1/oauth/token') continue;
      const allowed =
        r.method === 'GET' ||
        (r.method === 'POST' &&
          READ_POSTS.has(r.path.replace(/^\/api\/v2/, '')));
      assert.ok(allowed, `${r.method} ${r.path}`);
    }
    assert.equal(fake.state.grants.password, 1);
  });
});

describe('ituran-axi in other conditions', () => {
  it('retries once after the pressure guard', async () => {
    const f = await startFake({ pressureOnce: true });
    const r = await runBinary(['vehicles'], fakeEnv(f.url));
    assert.equal(r.code, 0, r.stdout);
    await f.close();
  });

  it('uses ITURAN_TOKEN as it is, and reports the Gate asking for a reconnect', async () => {
    const f = await startFake({ token: 'placeholder-token' });
    const tokenEnv = {
      ...fakeEnv(f.url),
      ITURAN_TOKEN: 'placeholder-token',
      ITURAN_USERNAME: '',
      ITURAN_PASSWORD: '',
    };
    const r = await runBinary(['vehicles'], tokenEnv);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(f.state.grants.password, 0);
    await f.close();
    const g = await startFake({ reconnect: true, token: 'placeholder-token' });
    const rr = await runBinary(['vehicles'], {
      ...tokenEnv,
      ITURAN_URL: g.url,
    });
    assert.equal(rr.code, 1);
    assert.match(rr.stdout, /^code: reconnect_needed$/m);
    await g.close();
  });

  it('says what is missing when nothing is connected', async () => {
    const r = await runBinary(['vehicles'], { HOME: '/nonexistent' });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^code: not_connected$/m);
    assert.match(r.stdout, /comis connect ituran/);
  });

  it('refuses a deadline that has passed without sending anything', async () => {
    const f = await startFake();
    const r = await runBinary(
      ['vehicles'],
      fakeEnv(f.url, { COMIS_DEADLINE: String(Date.now() - 1000) }),
    );
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^code: unreachable$/m);
    assert.equal(f.state.requests.length, 0);
    await f.close();
  });
});

describe('ituran-axi with temperature sensors', () => {
  let temps: Awaited<ReturnType<typeof startFake>>;
  let tempsEnv: Record<string, string>;
  before(async () => {
    temps = await startFake({ temps: true });
    tempsEnv = fakeEnv(temps.url);
  });
  after(() => temps.close());

  it('reads current sensors and a sampled history', async () => {
    const current = await runBinary(['temps'], tempsEnv);
    assert.equal(current.code, 0, current.stdout);
    assert.match(summary(current.stdout), /^1 sensor readings/);
    const history = await runBinary(
      ['temps', 'history', '12345678', '--date', '2026-11-07'],
      tempsEnv,
    );
    assert.equal(history.code, 0, history.stdout);
    assert.match(summary(history.stdout), /^2 readings from 2026-11-07/);
  });
});
