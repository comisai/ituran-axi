import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { decode } from '@toon-format/toon';
import { startFake } from '../fake/ituran-fake.ts';
import { fakeEnv, runBinary } from '../helpers.ts';

let fake: Awaited<ReturnType<typeof startFake>>;
let env: Record<string, string>;
before(async () => {
  fake = await startFake({ maintenanceRecords: true, placeCount: 1265 });
  env = fakeEnv(fake.url);
});
after(() => fake.close());
async function ok(...args: string[]) {
  const result = await runBinary(args, env);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.stderr, '');
  return decode(result.stdout) as Record<string, unknown>;
}
type Row = Record<string, unknown>;
it('returns second-level position age and current driver/group references', async () => {
  for (const args of [
    ['where', '12345678'],
    ['where', '--all'],
    ['vehicles'],
  ]) {
    const out = await ok(
      ...args,
      '--fields',
      'plate,age,age_seconds,driver,driver_id,groups,group_ids',
    );
    const row = (out.vehicles as Row[])[0] as Row;
    assert.equal(row.driver_id, 500);
    assert.equal(row.driver, 'Driver D0');
    assert.equal(row.groups, 'All');
    assert.equal(row.group_ids, '1');
    assert.ok(Number(row.age_seconds) >= 178 && Number(row.age_seconds) <= 182);
    assert.equal(row.age, '3m');
  }
  const one = await ok('vehicle', '12345678');
  assert.equal((one.position as Row).age, '3m');
  assert.equal(typeof (one.position as Row).age_seconds, 'number');
  assert.deepEqual(one.groups, [{ id: 1, name: 'All' }]);
});
it('reads explicit group membership and sums every matching BI row before paging', async () => {
  const group = await ok('groups', '1');
  assert.deepEqual(group.license_plates, ['12345678', '23456789', '12345678']);
  const tree = await ok('groups', '--vehicles');
  assert.equal((tree.groups as Row[])[1]?.plates, '23456789 34567890');
  for (const name of ['daily', 'periodic', 'idle']) {
    const out = await ok(
      'report',
      name,
      '--group',
      '1',
      '--date',
      '2026-11-07',
      '--limit',
      '1',
    );
    assert.equal(out.group_km, 10);
    assert.equal(out.group_vehicles, 2);
    assert.equal((out.rows as Row[]).length, 1);
    assert.match(String(out.summary), /1 of 2 rows/);
    if (name === 'idle')
      assert.equal(
        out.total,
        undefined,
        'fleet idle totals must not be attributed to a group',
      );
  }
});
it('reads dated saved-place events with place identities and a cursor', async () => {
  const out = await ok(
    'report',
    'events',
    '12345678',
    '--place',
    '77',
    '--date',
    '2026-11-07',
    '--full',
  );
  const rows = out.records as Row[];
  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map((r) => r.time),
    [
      '2026-11-07T00:00:00',
      '2026-11-07T02:00:00',
      '2026-11-07T04:00:00',
      '2026-11-07T06:00:00',
    ],
  );
  assert.equal(rows[0]?.place_ids, '77');
  assert.equal(rows[0]?.places, 'Depot');
  assert.equal(rows[0]?.time, '2026-11-07T00:00:00');
  assert.match(String(out.note), /arrival|departure/);
  const full = await ok(
    'report',
    'full',
    '12345678',
    '--place',
    '77',
    '--date',
    '2026-11-07',
    '--full',
  );
  assert.deepEqual(full.records, out.records);
});
it('exposes maintenance targets and states when a record has none', async () => {
  const out = await ok('maintenance');
  const rows = out.treatments as Row[];
  assert.equal(rows[0]?.['next.date'], '2026-12-01');
  assert.equal(rows[0]?.['next.odometer'], 20000);
  assert.equal(rows[1]?.['next.date'], null);
  assert.equal(out.without_due_target, 1);
});
it('explains current event states and the required speed threshold', async () => {
  const out = await ok('events', '--all');
  assert.match(JSON.stringify(out.help), /report events <plate> --since 24h/);
  const missing = await runBinary(['report', 'speed', '12345678'], env);
  assert.equal(missing.code, 2);
  assert.match(missing.stdout, /needs --over <km\/h>/);
  for (const args of [
    ['report', 'daily', '--place', '77'],
    ['report', 'events', '12345678', '--group', '1'],
  ]) {
    const result = await runBinary(args, env);
    assert.equal(result.code, 2, result.stdout);
  }
});
it('finds a saved place beyond the first 200 and pages the listing', async () => {
  const out = await ok('places', 'Site 1264', '--refresh');
  assert.equal(out.index, 'built now: 1265 places');
  assert.equal((out.places as Row[])[0]?.id, 11264);
  const page = await ok('places', '--page', '7', '--limit', '200', '--full');
  assert.equal((page.places as Row[]).length, 65);
});

it('pages diagnostic readings so the default sample can be completed', async () => {
  const first = await ok('diagnostics', '--all', '--limit', '1', '--full');
  const second = await ok(
    'diagnostics',
    '--all',
    '--limit',
    '1',
    '--page',
    '2',
    '--full',
  );
  assert.notDeepEqual(first.readings, second.readings);
  assert.match(JSON.stringify(first.help), /--page 2/);
});

it('distinguishes empty group membership from unavailable membership', async () => {
  for (const plates of [[], null]) {
    const server = await startFake({ groupPlates: plates });
    try {
      const result = await runBinary(
        ['report', 'periodic', '--group', '1', '--date', '2026-11-07'],
        fakeEnv(server.url),
      );
      const out = decode(result.stdout) as Row;
      if (plates === null) {
        assert.equal(result.code, 1);
        assert.equal(out.code, 'ituran_error');
        assert.match(String(out.message), /membership/);
      } else {
        assert.equal(result.code, 0, result.stdout);
        assert.equal(out.group_km, 0);
        assert.equal(out.group_vehicles, 0);
        assert.deepEqual(out.rows, []);
      }
    } finally {
      server.close();
    }
  }
});

it('does not turn a missing group member report into zero mileage', async () => {
  const server = await startFake({ groupPlates: ['12345678', '99887766'] });
  try {
    const result = await runBinary(
      ['report', 'periodic', '--group', '1', '--date', '2026-11-07'],
      fakeEnv(server.url),
    );
    assert.equal(result.code, 0, result.stdout);
    const out = decode(result.stdout) as Row;
    assert.equal(out.group_km, null);
    assert.equal(out.group_reported_vehicles, 1);
    assert.equal(out.group_unreported_vehicles, 1);
  } finally {
    server.close();
  }
});
