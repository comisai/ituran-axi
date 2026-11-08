// The ten AXI principles (axi.md, and the stricter Comis reading), checked
// against the real binary as a separate process. Set ITURAN_AXI_BIN=dist to
// check the built package instead of the source.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { decode } from '@toon-format/toon';
import { COMMANDS } from '../../src/cli/run.ts';
import { startFake } from '../fake/ituran-fake.ts';
import { fakeEnv, runBinary } from '../helpers.ts';

let fake: Awaited<ReturnType<typeof startFake>>;
let env: Record<string, string>;
const run = (...args: string[]) => runBinary(args, env);

before(async () => {
  fake = await startFake();
  env = fakeEnv(fake.url);
});
after(() => fake.close());

function body(text: string): Record<string, unknown> {
  const [encoded = ''] = text.split(/^help\[\d+\]:\n/m);
  return decode(encoded) as Record<string, unknown>;
}

function helpLines(text: string): string[] {
  const m = /^help\[(\d+)\]:\n((?: {2}.*\n)*)$/m.exec(text);
  if (!m) return [];
  const lines = (m[2] ?? '').split('\n').filter(Boolean);
  assert.equal(lines.length, Number(m[1]), 'help[n] counts its lines');
  return lines;
}

const LISTS: string[][] = [
  ['vehicles'],
  ['vehicles', 'Van', '--limit', '3'],
  ['where', '--all'],
  ['trips', '12345678', '--date', '2026-11-07'],
  ['drivers'],
  ['places', '--limit', '5'],
  ['events'],
];
const DETAILS: string[][] = [
  ['vehicle', '12345678'],
  ['trip', '5000'],
  ['driver', '500'],
  ['totals', '--date', '2026-11-07'],
];

describe('AXI principles', () => {
  it('1. output is TOON from the official encoder, on stdout only', async () => {
    for (const args of [[], ...LISTS, ...DETAILS]) {
      const r = await run(...args);
      assert.equal(r.code, 0, `${args.join(' ')}: ${r.stdout}`);
      assert.equal(r.stderr, '', args.join(' '));
      assert.doesNotThrow(() => body(r.stdout), args.join(' '));
    }
  });

  it('2. list rows carry three to five fields by default', async () => {
    for (const args of LISTS) {
      const doc = body((await run(...args)).stdout);
      const key = Object.keys(doc).find((k) => Array.isArray(doc[k])) as string;
      const rows = doc[key] as Record<string, unknown>[];
      assert.ok(rows.length > 0, args.join(' '));
      for (const row of rows) {
        const n = Object.keys(row).length;
        assert.ok(n >= 3 && n <= 5, `${args.join(' ')}: ${n} fields`);
      }
    }
  });

  it('3. long text is cut with its size and a --full hint', async () => {
    const r = await run('vehicle', '6789012');
    assert.match(
      r.stdout,
      / … \(truncated, 650 code points total; use --full to see all\)/,
    );
    const full = await run('vehicle', '6789012', '--full');
    assert.doesNotMatch(full.stdout, /truncated/);
  });

  it('4. every list states its count, and partial answers say how to read more', async () => {
    for (const args of LISTS) {
      const doc = body((await run(...args)).stdout);
      assert.match(String(doc.summary), /^(0|[1-9][0-9]*) /, args.join(' '));
    }
    const partial = await run('vehicles', '--limit', '2');
    assert.match(String(body(partial.stdout).summary), /^2 of 13 vehicles$/);
    assert.ok(helpLines(partial.stdout).some((l) => /--page 2/.test(l)));
  });

  it('5. an empty answer is stated, not blank', async () => {
    const r = await run('trips', '--date', '2026-11-01');
    assert.equal(r.code, 0);
    assert.equal(body(r.stdout).summary, '0 trips for all vehicles');
    assert.match(
      String(body((await run('vehicles', 'no-such-van')).stdout).summary),
      /^0 vehicles/,
    );
  });

  it('6. errors are structured records on stdout: message, code, usage', async () => {
    for (const args of [
      ['temps'],
      ['vehicle', '00000000'],
      ['vehicle'],
      ['vehicles', '--bogus'],
      ['trips', '99887766', '--date', '2026-11-07'],
    ]) {
      const r = await run(...args);
      assert.equal(r.stderr, '', args.join(' '));
      const doc = body(r.stdout);
      assert.deepEqual(
        Object.keys(doc).slice(0, 3),
        ['message', 'code', 'usage'],
        args.join(' '),
      );
      assert.match(String(doc.code), /^[a-z][a-z_]*$/);
      assert.doesNotMatch(r.stdout, /\n\s+at\s|ECONN|secret-pass|tok1/);
    }
  });

  it('7. exit codes are 0, 1 and 2', async () => {
    assert.equal((await run('vehicles')).code, 0);
    assert.equal((await run('temps')).code, 1);
    assert.equal((await run('vehicles', '--limit', 'x')).code, 2);
    assert.equal((await run('frobnicate')).code, 2);
  });

  it('8. the home view shows live data with no arguments', async () => {
    const doc = body((await run()).stdout);
    assert.equal(doc.vehicles, 13);
    assert.equal(doc.account, 'Example Ltd · user user_a (Manager)');
    assert.match(String(doc.bin), /ituran-axi/);
    assert.match(String(doc.description), /^Read Ituran/);
  });

  it('9. lists end with one to three runnable next steps; detail views with none', async () => {
    for (const args of [[], ...LISTS]) {
      const lines = helpLines((await run(...args)).stdout);
      assert.ok(
        lines.length >= 1 && lines.length <= 3,
        `${args.join(' ')}: ${lines.length}`,
      );
      for (const line of lines)
        assert.match(line, /^ {2}Run `ituran-axi [a-z<][^`]*`/, line);
    }
    for (const args of DETAILS)
      assert.deepEqual(
        helpLines((await run(...args)).stdout),
        [],
        args.join(' '),
      );
  });

  it('10. every command has a short --help from the one command table', async () => {
    for (const spec of COMMANDS) {
      const r = await runBinary([...(spec.name ? [spec.name] : []), '--help'], {
        HOME: '/nonexistent',
      });
      assert.equal(r.code, 0, spec.name);
      // The overview lists every command; a command's own help stays short.
      const cap = spec.name ? 1500 : 2000;
      assert.ok(
        r.stdout.length < cap,
        `${spec.name || '(overview)'}: ${r.stdout.length}`,
      );
      assert.match(r.stdout, /^(command|description): /);
    }
  });

  it('refuses unknown flags by name and never echoes their values', async () => {
    const r = await run('vehicles', '--password=hunter2');
    assert.equal(r.code, 2);
    assert.match(r.stdout, /Unknown flag --password/);
    assert.doesNotMatch(r.stdout, /hunter2/);
  });

  it('fits default output in 4,000 UTF-16 units', async () => {
    for (const args of [
      [],
      ...LISTS,
      ...DETAILS,
      [
        'vehicles',
        '--limit',
        '2000',
        '--fields',
        'plate,name,model,status,address',
      ],
      ['trip', '5000', '--points', '--limit', '2000'],
    ]) {
      const r = await run(...args);
      assert.ok(
        r.stdout.length <= 4000,
        `${args.join(' ')}: ${r.stdout.length}`,
      );
    }
  });

  it('escapes hidden bidirectional controls in values', async () => {
    const r = await run('vehicles', '--limit', '3');
    assert.doesNotMatch(r.stdout, /\u202e/);
    const rows = body(r.stdout).vehicles as Record<string, unknown>[];
    assert.ok(
      rows.some((v) => v.name === 'Van \\u202e3'),
      JSON.stringify(rows),
    );
  });

  it('never prompts: commands finish with stdin closed', async () => {
    assert.equal((await run('where', '--all')).code, 0);
  });
});
