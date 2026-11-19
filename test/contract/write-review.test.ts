import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { decode } from '@toon-format/toon';
import { tokenDir } from '../../src/auth.ts';
import { main } from '../../src/cli/run.ts';
import { readSettings } from '../../src/config.ts';
import { defaultDeps } from '../../src/http.ts';
import { type FakeOptions, startFake } from '../fake/ituran-fake.ts';
import { fakeEnv, runBinary } from '../helpers.ts';

const args = ['place', 'add', '--body', '{"name":"Depot A"}', '--confirm'];
const doc = (stdout: string) => decode(stdout) as Record<string, unknown>;
const uncertain = (stdout: string) => {
  assert.match(stdout, /may have been applied/);
  assert.match(stdout, /may be waiting for the owner's card/);
  assert.match(stdout, /Do not repeat/);
  assert.match(stdout, /comis action list|ituran-axi places/);
};

describe('pre-release write review', () => {
  it('explains uncertain timeout, disconnect and 5xx outcomes without resending', async () => {
    for (const fault of [
      { stall: 'headers' },
      { writeDrop: true },
      {
        writeReply: {
          status: 503,
          json: { error_code: '503', error_description: 'Try later' },
        },
      },
    ] as FakeOptions[]) {
      const fake = await startFake({ token: 'fake-token', ...fault });
      try {
        const result = await runBinary(
          args,
          fakeEnv(fake.url, {
            ITURAN_TOKEN: 'fake-token',
            COMIS_DEADLINE: String(Date.now() + 1800),
          }),
        );
        assert.equal(result.code, 1, result.stdout);
        uncertain(result.stdout);
        assert.equal(fake.state.requests.length, 1);
      } finally {
        await fake.close();
      }
    }
  });

  it('names the waiting card, prohibits repetition and points to actions when no action ID arrives', async () => {
    const fake = await startFake({
      token: 'fake-token',
      writeReply: {
        status: 503,
        headers: { 'comis-refusal': 'approval_pending' },
      },
    });
    try {
      const result = await runBinary(
        args,
        fakeEnv(fake.url, { ITURAN_TOKEN: 'fake-token' }),
      );
      assert.equal(doc(result.stdout).code, 'held_for_approval');
      assert.match(result.stdout, /Do not repeat/);
      assert.match(result.stdout, /comis action list/);
      assert.equal(fake.state.requests.length, 1);
    } finally {
      await fake.close();
    }
  });

  it('leaves a confirmed write enough budget after the 45-second card hold', async () => {
    const fake = await startFake({ token: 'fake-token' });
    try {
      const env = fakeEnv(fake.url, { ITURAN_TOKEN: 'fake-token' });
      let stdout = '';
      // Advance the injected request clock beyond the Gate hold without sleeping.
      const code = await main(args, {
        env,
        stdout: (text) => {
          stdout += text;
        },
        now: () => new Date(Date.now() + 46_000),
        http: defaultDeps,
      });
      assert.equal(code, 0, stdout);
      assert.equal(fake.state.requests.length, 1);
    } finally {
      await fake.close();
    }
  });

  it('keeps a shorter task deadline while waiting for the command lock, sending nothing', async () => {
    const fake = await startFake({ token: 'fake-token' });
    try {
      const env = fakeEnv(fake.url, {
        ITURAN_TOKEN: 'fake-token',
        COMIS_DEADLINE: String(Date.now() + 1800),
      });
      mkdirSync(env.ITURAN_AXI_LOCK_DIR as string, { recursive: true });
      writeFileSync(
        join(env.ITURAN_AXI_LOCK_DIR as string, 'command.lock'),
        JSON.stringify({
          pid: process.pid,
          hostname: hostname(),
          token: 'review-lock',
        }),
      );
      const started = Date.now();
      const result = await runBinary(args, env);
      assert.equal(result.code, 1, result.stdout);
      assert.equal(doc(result.stdout).code, 'busy');
      assert.ok(Date.now() - started < 3000);
      assert.equal(fake.state.requests.length, 0);
    } finally {
      await fake.close();
    }
  });

  it('only treats plain record-not-found DELETE answers as already absent and preserves status and words', async () => {
    for (const code of ['404', '1020', '404.3', undefined]) {
      const fake = await startFake({
        token: 'fake-token',
        writeReply: {
          status: 404,
          json: {
            error_code: code,
            error_description:
              code === '1020' ? 'Vehicle not found' : 'Record not found',
          },
        },
      });
      try {
        const result = await runBinary(
          ['alert', 'remove', '201', '--plate', '10000009', '--confirm'],
          fakeEnv(fake.url, { ITURAN_TOKEN: 'fake-token' }),
        );
        const data = doc(result.stdout);
        assert.equal(result.code, code === '404' ? 0 : 1, result.stdout);
        assert.match(result.stdout, /status: 404/);
        assert.match(result.stdout, /ituran: (Vehicle|Record) not found/);
        if (code !== '404') {
          assert.doesNotMatch(result.stdout, /already_absent/);
          assert.equal(data.codes, code);
        }
      } finally {
        await fake.close();
      }
    }
  });

  it('prints only bounded allowed success fields, excluding echoed contacts and arbitrary fields', async () => {
    const fake = await startFake({
      token: 'fake-token',
      writeReply: {
        status: 200,
        json: {
          place_id: 101,
          result: true,
          contacts: [
            {
              name: 'Synthetic contact',
              phone: '0500000000',
              email: 'synthetic@example.invalid',
            },
          ],
          note: 'z'.repeat(10000),
        },
      },
    });
    try {
      const result = await runBinary(
        args,
        fakeEnv(fake.url, { ITURAN_TOKEN: 'fake-token' }),
      );
      assert.equal(result.code, 0, result.stdout);
      assert.match(result.stdout, /place_id: 101/);
      assert.ok(result.stdout.length <= 4000);
      assert.doesNotMatch(
        result.stdout,
        /Synthetic contact|0500000000|synthetic@|zzzz|contacts/,
      );
    } finally {
      await fake.close();
    }
  });

  it('returns a bounded incomplete error for result false or failed vehicles without echoing their other fields', async () => {
    for (const json of [
      { result: false },
      {
        result: true,
        failed_vehicles: Array.from({ length: 2000 }, (_, i) => ({
          license_plate: String(10000001 + i),
          contact_name: 'Synthetic contact',
          phone: '0500000000',
          email: 'synthetic@example.invalid',
          description: 'z'.repeat(500),
        })),
      },
    ]) {
      const fake = await startFake({
        token: 'fake-token',
        writeReply: { status: 200, json },
      });
      try {
        const result = await runBinary(
          [
            'group',
            'members',
            '301',
            '--body',
            '{"license_plates":{"add":["10000002"]}}',
            '--confirm',
          ],
          fakeEnv(fake.url, { ITURAN_TOKEN: 'fake-token' }),
        );
        assert.equal(result.code, 1, result.stdout);
        const data = doc(result.stdout);
        assert.equal(data.code, 'write_incomplete');
        assert.match(String(data.summary), /incomplete/i);
        assert.match(result.stdout, /Do not repeat/);
        assert.ok(result.stdout.length <= 4000);
        assert.doesNotMatch(
          result.stdout,
          /Synthetic contact|0500000000|synthetic@|zzzz/,
        );
        if (json.failed_vehicles) {
          assert.equal(data.failed_vehicles_count, 2000);
          assert.match(result.stdout, /10000001/);
        }
      } finally {
        await fake.close();
      }
    }
  });

  it('forgets a refused cached token without replaying the write or signing in again', async () => {
    const fake = await startFake({
      writeReply: { status: 401, json: { error_code: '401' } },
    });
    try {
      const env = fakeEnv(fake.url);
      const result = await runBinary(args, env);
      assert.equal(result.code, 1, result.stdout);
      const file = join(
        tokenDir(readSettings(env), 'user_a', env),
        'token.json',
      );
      assert.equal(existsSync(file), false);
      assert.deepEqual(fake.state.grants, { password: 1, refresh: 0 });
      assert.equal(
        fake.state.requests.filter((r) => r.path === '/api/v2/places').length,
        1,
      );
      assert.equal((await runBinary(['vehicles'], env)).code, 0);
      assert.equal(fake.state.grants.password, 2);
    } finally {
      await fake.close();
    }
  });

  it('keeps the read-only live harness version equal to the package without running it', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    const live = readFileSync(
      new URL('../live/ituran-live.mjs', import.meta.url),
      'utf8',
    );
    assert.match(
      live,
      new RegExp(`const VERSION = '${pkg.version.replaceAll('.', '\\.')}'`),
    );
  });
});
