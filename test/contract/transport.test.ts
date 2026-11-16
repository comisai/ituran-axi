import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { startFake } from '../fake/ituran-fake.ts';
import { BIN, fakeEnv, runBinary } from '../helpers.ts';

function boundedRun(args: string[], env: Record<string, string>) {
  return new Promise<{
    code: number | null;
    signal: string | null;
    stdout: string;
    exitDelay: number;
  }>((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env });
    let stdout = '';
    let answeredAt = 0;
    child.stdout.on('data', (data) => {
      stdout += data;
      answeredAt ||= Date.now();
    });
    child.stdin.end();
    const guard = setTimeout(() => child.kill('SIGKILL'), 4000);
    child.on('close', (code, signal) => {
      clearTimeout(guard);
      resolve({ code, signal, stdout, exitDelay: Date.now() - answeredAt });
    });
  });
}

describe('transport lifecycle across real CLI processes', () => {
  it('exits after a timeout while the environment proxy never answers CONNECT', {
    skip: !process.allowedNodeEnvironmentFlags.has('--use-env-proxy'),
  }, async () => {
    const fake = await startFake({ stallProxy: true });
    try {
      const result = await boundedRun(
        ['vehicles'],
        fakeEnv('https://ituran.invalid/api/v2', {
          ITURAN_TOKEN: 'fake-token',
          HTTPS_PROXY: new URL(fake.url).origin,
          NODE_USE_ENV_PROXY: '1',
          COMIS_DEADLINE: String(Date.now() + 1800),
        }),
      );
      assert.equal(fake.state.requests[0]?.method, 'CONNECT');
      assert.equal(result.signal, null, JSON.stringify(result));
      assert.equal(result.code, 1, result.stdout);
      assert.match(result.stdout, /Ituran did not answer within/);
      assert.ok(result.exitDelay < 800, `exit delayed ${result.exitDelay} ms`);
      await sleep(50);
      assert.equal(fake.activeConnections(), 0, 'proxy socket was released');
    } finally {
      await fake.close();
    }
  });
  for (const stall of ['headers', 'body', 'stream'] as const) {
    it(`exits promptly after a timeout with stalled ${stall}`, async () => {
      const fake = await startFake({ stall, token: 'fake-token' });
      try {
        const result = await boundedRun(
          [
            'trips',
            '12345678',
            '--from',
            '2020-01-01',
            '--to',
            '2026-11-15',
            '--limit',
            '5',
          ],
          fakeEnv(fake.url, {
            ITURAN_TOKEN: 'fake-token',
            COMIS_DEADLINE: String(Date.now() + 1800),
          }),
        );
        assert.equal(result.signal, null, JSON.stringify(result));
        assert.equal(result.code, 1, result.stdout);
        assert.match(result.stdout, /^code: unreachable$/m);
        assert.match(result.stdout, /Ituran did not answer within/);
        assert.ok(
          result.exitDelay < 800,
          `exit delayed ${result.exitDelay} ms`,
        );
        assert.equal(fake.state.requests.length, 1);
      } finally {
        await fake.close();
      }
    });
  }

  it('serializes concurrent invocations and keeps the pacing gap between them', async () => {
    const fake = await startFake({ token: 'fake-token', answerDelayMs: 650 });
    const env = fakeEnv(fake.url, { ITURAN_TOKEN: 'fake-token' });
    try {
      const results = await Promise.all([
        runBinary(['vehicles'], env),
        runBinary(['drivers'], env),
        runBinary(['places'], env),
      ]);
      for (const result of results) assert.equal(result.code, 0, result.stdout);
      const starts = fake.state.requests.map((request) => request.at);
      assert.equal(starts.length, 3);
      for (let i = 1; i < starts.length; i++) {
        assert.ok(
          (starts[i] as number) - (starts[i - 1] as number) >= 1040,
          `overlapping reads: ${JSON.stringify(fake.state.requests)}`,
        );
      }
    } finally {
      await fake.close();
    }
  });

  it('bounds the lock wait by the deadline, leaves its owner alone, and keeps help available', async () => {
    const fake = await startFake({ token: 'fake-token' });
    const env = fakeEnv(fake.url, { ITURAN_TOKEN: 'fake-token' });
    const dir = join(env.XDG_CACHE_HOME as string, 'ituran-axi');
    const lock = join(dir, 'command.lock');
    mkdirSync(dir, { recursive: true });
    writeFileSync(lock, 'existing-owner\n');
    const old = new Date(Date.now() - 3600_000);
    utimesSync(lock, old, old);
    try {
      const help = await runBinary(['--help'], env);
      assert.equal(help.code, 0, help.stdout);
      const result = await boundedRun(['vehicles'], {
        ...env,
        COMIS_DEADLINE: String(Date.now() + 1700),
      });
      assert.equal(result.signal, null);
      assert.equal(result.code, 1, result.stdout);
      assert.match(result.stdout, /Another ituran-axi command is running/);
      assert.match(result.stdout, /^code: unreachable$/m);
      assert.equal(readFileSync(lock, 'utf8'), 'existing-owner\n');
      assert.equal(fake.state.requests.length, 0);
      rmSync(lock);
      assert.equal((await runBinary(['vehicles'], env)).code, 0);
      assert.equal(existsSync(lock), false);
    } finally {
      rmSync(lock, { force: true });
      await fake.close();
    }
  });

  it('releases the command lock after a request fails', async () => {
    const fake = await startFake({ reconnect: true, token: 'fake-token' });
    const env = fakeEnv(fake.url, { ITURAN_TOKEN: 'fake-token' });
    try {
      const results = await Promise.all([
        runBinary(['vehicles'], env),
        runBinary(['drivers'], env),
      ]);
      for (const result of results) {
        assert.equal(result.code, 1, result.stdout);
        assert.match(result.stdout, /^code: reconnect_needed$/m);
      }
      assert.equal(fake.state.requests.length, 2);
      assert.equal(
        existsSync(
          join(env.XDG_CACHE_HOME as string, 'ituran-axi', 'command.lock'),
        ),
        false,
      );
    } finally {
      await fake.close();
    }
  });
});
