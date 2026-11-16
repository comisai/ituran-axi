// A window that runs into the future, while a vehicle drives: the printed
// window, the rows and the totals must agree (live round seven, R7-04).

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { decode } from '@toon-format/toon';
import { DRIVING, startFake } from '../fake/ituran-fake.ts';
import { fakeEnv, runBinary } from '../helpers.ts';

let fake: Awaited<ReturnType<typeof startFake>>;
let env: Record<string, string>;
before(async () => {
  fake = await startFake({ liveTrip: true });
  env = fakeEnv(fake.url);
});
after(() => fake.close());

type Doc = Record<string, unknown>;

async function ok(...args: string[]): Promise<Doc> {
  const r = await runBinary(args, env);
  assert.equal(r.code, 0, `${args.join(' ')}\n${r.stdout}`);
  assert.equal(r.stderr, '', args.join(' '));
  return decode(r.stdout) as Doc;
}

/** The account's wall clock, `ago` milliseconds back, as naive local text. */
function local(ago = 0): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
    .format(new Date(Date.now() - ago))
    .replace(' ', 'T');
}

/** The printed window's bounds, to the second. */
function bounds(d: Doc): [string, string] {
  const m = /^(\S+) to (\S+)/.exec(String(d.window));
  assert.ok(m, String(d.window));
  return [m[1] as string, m[2] as string];
}

const second = (t: unknown) => String(t).slice(0, 19);

// From six hours ago to the end of tomorrow: the trip that ended earlier
// belongs, the one under way does not end inside the window.
const from = local(6 * 3_600_000).slice(0, 16);
const tomorrow = local(-86_400_000).slice(0, 10);
const future = ['--from', from, '--to', `${tomorrow}T23:59`];

describe('a window that runs into the future', () => {
  it('lists only trips that end inside the printed window', async () => {
    const d = await ok('trips', DRIVING, ...future, '--fields', 'id,end,km');
    const [start, end] = bounds(d);
    assert.equal(start, `${from}:00`);
    assert.ok(end <= local(), `window end ${end} is in the future`);
    assert.match(String(d.matched), /end time/);
    assert.match(
      String(d.clamped),
      new RegExp(`${tomorrow}T23:59:00.*future.*${end}`),
    );
    const rows = d.trips as Doc[];
    for (const r of rows) {
      assert.ok(second(r.end) >= start, `trip ${r.id} ends before the window`);
      assert.ok(second(r.end) <= end, `trip ${r.id} ends after the window`);
    }
    assert.deepEqual(
      rows.map((r) => r.id),
      [9100],
    );
    assert.equal(d.summary, `1 trip for ${DRIVING} · 40 km`);
    assert.match(String(d.left_out), /1 trip .*9101.*not counted/);
  });

  it('sums only those trips per vehicle', async () => {
    const d = await ok('trips', DRIVING, ...future, '--by', 'plate');
    assert.match(String(d.summary), /^1 vehicle · 1 trips · 40 km over /);
    assert.deepEqual(
      (d.vehicles as Doc[]).map((r) => [r.plate, r.trips, r.km]),
      [[DRIVING, 1, 40]],
    );
    assert.match(String(d.left_out), /1 trip .*9101.*not counted/);
    assert.match(String(d.clamped), /future/);
  });

  it('keeps event records inside the printed window', async () => {
    const d = await ok('report', 'events', DRIVING, ...future);
    const [start, end] = bounds(d);
    for (const r of d.records as Doc[]) {
      assert.ok(second(r.time) >= start && second(r.time) <= end);
    }
    assert.match(String(d.summary), /^0 records of the events report/);
    assert.match(String(d.left_out), /1 record .*after the window/);
    assert.match(String(d.clamped), /future/);
  });

  it('says when whole-day windows stop at today', async () => {
    const totals = await ok(
      'totals',
      '--from',
      from.slice(0, 10),
      '--to',
      tomorrow,
    );
    assert.match(
      String(totals.window),
      new RegExp(`to ${local().slice(0, 10)} `),
    );
    assert.match(String(totals.clamped), new RegExp(`${tomorrow}.*future`));
    const daily = await ok(
      'report',
      'daily',
      '--from',
      from.slice(0, 10),
      '--to',
      tomorrow,
    );
    assert.match(String(daily.clamped), new RegExp(`${tomorrow}.*future`));
  });

  it('says nothing of clamping when the window ends now by default', async () => {
    const d = await ok('trips', DRIVING, '--since', '6h');
    assert.equal(d.clamped, undefined);
    assert.match(String(d.left_out), /9101/);
  });
});
