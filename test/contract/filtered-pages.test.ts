// A page of trips that keeps none of Ituran's rows is not an empty window
// (live round eight, R8-01): three trips under way fill the first page of
// three, while one vehicle finished four trips inside the window.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { decode } from '@toon-format/toon';
import { FOUR_TRIPS, startFake } from '../fake/ituran-fake.ts';
import { fakeEnv, runBinary } from '../helpers.ts';

let fake: Awaited<ReturnType<typeof startFake>>;
let env: Record<string, string>;
before(async () => {
  fake = await startFake({ strayFleet: true });
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

const window = ['--since', '24h'];
const ids = (d: Doc) => ((d.trips ?? []) as Doc[]).map((t) => t.id);
const help = (d: Doc) => ((d.help ?? []) as string[]).join('\n');

describe('a filtered page of trips', () => {
  it('says an all-stray page is none on this page, not a zero window', async () => {
    const d = await ok(
      'trips',
      ...window,
      '--limit',
      '3',
      '--fields',
      'end,km',
    );
    assert.deepEqual(ids(d), []);
    assert.doesNotMatch(String(d.summary), /^0 trips/);
    assert.equal(
      d.summary,
      'none on page 1 of 3 for all vehicles; the total in the window is unknown: Ituran listed 7, trips that end outside the window included',
    );
    assert.match(String(d.left_out), /^3 trips .*not counted/);
    assert.match(
      help(d),
      /Run `ituran-axi trips --since 24h --page 2 --limit 3` for page 2 of 3/,
    );
  });

  it('reaches every later trip in the window by the continuation', async () => {
    const two = await ok('trips', ...window, '--limit', '3', '--page', '2');
    assert.deepEqual(ids(two), [9300, 9301, 9302]);
    assert.equal(two.summary, '3 of up to 7 trips for all vehicles');
    assert.equal(two.left_out, undefined);
    assert.match(
      help(two),
      /Run `ituran-axi trips --since 24h --page 3 --limit 3` for page 3 of 3/,
    );
    const three = await ok('trips', ...window, '--limit', '3', '--page', '3');
    assert.deepEqual(ids(three), [9303]);
    assert.equal(three.summary, '1 of up to 7 trips for all vehicles');
    assert.doesNotMatch(help(three), /--page 4/);
  });

  it('says past the last page that the list ended', async () => {
    const d = await ok('trips', ...window, '--limit', '3', '--page', '4');
    assert.deepEqual(ids(d), []);
    assert.equal(
      d.summary,
      "none on page 4 for all vehicles; Ituran's list ends at page 3",
    );
  });

  it('counts the one vehicle whose trips the fleet pages hold', async () => {
    const d = await ok('trips', FOUR_TRIPS, ...window, '--limit', '20');
    assert.deepEqual(ids(d), [9300, 9301, 9302, 9303]);
    assert.equal(d.summary, `4 trips for ${FOUR_TRIPS} · 109 km`);
    assert.equal(d.left_out, undefined);
  });

  it('counts the whole window when every listed trip was seen', async () => {
    const d = await ok('trips', ...window, '--limit', '20');
    assert.equal(d.summary, '4 trips for all vehicles · 109 km');
    assert.match(String(d.left_out), /^3 trips /);
  });
});
