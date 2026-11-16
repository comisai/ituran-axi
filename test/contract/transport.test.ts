import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { startFake } from '../fake/ituran-fake.ts';
import { BIN, fakeEnv, runBinary, tempDir } from '../helpers.ts';

function startProcess(args: string[], env: Record<string, string>) {
  const child = spawn(process.execPath, args, { env });
  let stdout = '';
  child.stdout.on('data', (data) => {
    stdout += data;
  });
  child.stdin.end();
  const guard = setTimeout(() => child.kill('SIGKILL'), 8000);
  const closed = new Promise<{
    code: number | null;
    signal: string | null;
    stdout: string;
  }>((resolve) => {
    child.on('close', (code, signal) => {
      clearTimeout(guard);
      resolve({ code, signal, stdout });
    });
  });
  return { child, closed };
}

async function waitFor(check: () => boolean) {
  const until = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < until, 'holder did not start');
    await sleep(10);
  }
}

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
    const owner = JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      token: 'existing-owner',
    });
    writeFileSync(lock, owner);
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
      assert.match(result.stdout, /^code: busy$/m);
      assert.doesNotMatch(result.stdout, /remove.*lock/);
      assert.equal(readFileSync(lock, 'utf8'), owner);
      assert.equal(fake.state.requests.length, 0);
      rmSync(lock);
      assert.equal((await runBinary(['vehicles'], env)).code, 0);
      assert.equal(existsSync(lock), false);
    } finally {
      rmSync(lock, { force: true });
      await fake.close();
    }
  });

  for (const signal of ['SIGKILL', 'SIGINT', 'SIGTERM'] as const) {
    it(`recovers after ${signal} of a real holder`, async () => {
      const stalled = await startFake({
        stall: 'headers',
        token: 'fake-token',
      });
      const ready = await startFake({ token: 'fake-token' });
      const env = fakeEnv(stalled.url, { ITURAN_TOKEN: 'fake-token' });
      const lock = join(
        env.XDG_CACHE_HOME as string,
        'ituran-axi',
        'command.lock',
      );
      const holder = startProcess([BIN, 'vehicles'], env);
      try {
        await waitFor(() => stalled.state.requests.length === 1);
        if (signal === 'SIGKILL') {
          const owner = JSON.parse(readFileSync(lock, 'utf8'));
          assert.equal(owner.pid, holder.child.pid);
          assert.equal(owner.hostname, hostname());
          assert.equal(typeof owner.token, 'string');
          assert.ok(owner.token.length >= 16);
          const before = statSync(lock).mtimeMs;
          await sleep(2200);
          assert.ok(
            statSync(lock).mtimeMs > before,
            'holder refreshes its lease',
          );
        }
        holder.child.kill(signal);
        const stopped = await holder.closed;
        if (signal === 'SIGKILL') assert.equal(stopped.signal, signal);
        else {
          assert.equal(stopped.code, signal === 'SIGINT' ? 130 : 143);
          assert.equal(
            existsSync(lock),
            false,
            'signal releases lock immediately',
          );
        }
        const results = await Promise.all(
          ['vehicles', 'drivers', 'places'].map((command) =>
            boundedRun([command], {
              ...env,
              ITURAN_URL: ready.url,
              COMIS_DEADLINE: String(Date.now() + 3500),
            }),
          ),
        );
        for (const result of results) {
          assert.equal(result.code, 0, result.stdout);
          assert.equal(result.signal, null);
        }
        assert.equal(ready.state.requests.length, 3);
        for (let i = 1; i < ready.state.requests.length; i++) {
          assert.ok(
            (ready.state.requests[i]?.at ?? 0) -
              (ready.state.requests[i - 1]?.at ?? 0) >=
              390,
          );
        }
        assert.equal(existsSync(lock), false);
      } finally {
        holder.child.kill('SIGKILL');
        await holder.closed;
        await stalled.close();
        await ready.close();
      }
    });
  }

  it('releases its lock on process.exit inside a command, before finally can run', async () => {
    const env = fakeEnv('http://127.0.0.1:1/api/v2');
    const module = new URL(
      `../command-lock.${BIN.endsWith('.ts') ? 'ts' : 'js'}`,
      pathToFileURL(BIN),
    );
    const holder = startProcess(
      [
        '--input-type=module',
        '-e',
        `
      import { withCommandLock } from ${JSON.stringify(module.href)};
      await withCommandLock(process.env, undefined, async () => process.exit(0));
    `,
      ],
      env,
    );
    const result = await holder.closed;
    assert.equal(result.code, 0);
    const dir = join(env.XDG_CACHE_HOME as string, 'ituran-axi');
    assert.equal(existsSync(join(dir, 'command.lock')), false);
    assert.ok(
      existsSync(join(dir, 'command.next')),
      'exit handler ran cleanup',
    );
  });

  it('does not let the heartbeat keep an otherwise idle process alive', async () => {
    const env = fakeEnv('http://127.0.0.1:1/api/v2');
    const module = new URL(
      `../command-lock.${BIN.endsWith('.ts') ? 'ts' : 'js'}`,
      pathToFileURL(BIN),
    );
    const holder = startProcess(
      [
        '--input-type=module',
        '-e',
        `
      import { withCommandLock } from ${JSON.stringify(module.href)};
      void withCommandLock(process.env, undefined, async () => new Promise(() => {}));
    `,
      ],
      env,
    );
    const result = await holder.closed;
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    const dir = join(env.XDG_CACHE_HOME as string, 'ituran-axi');
    assert.equal(existsSync(join(dir, 'command.lock')), false);
    assert.ok(existsSync(join(dir, 'command.next')));
  });

  it('uses a shared temporary fallback when the cache is read-only', async () => {
    const fake = await startFake({ token: 'fake-token', answerDelayMs: 200 });
    const env = fakeEnv(fake.url, {
      ITURAN_TOKEN: 'fake-token',
      TMPDIR: tempDir(),
    });
    mkdirSync(env.XDG_CACHE_HOME as string, { recursive: true });
    chmodSync(env.XDG_CACHE_HOME as string, 0o500);
    try {
      const results = await Promise.all([
        runBinary(['vehicles'], env),
        runBinary(['drivers'], env),
      ]);
      for (const result of results) assert.equal(result.code, 0, result.stdout);
      assert.equal(fake.state.requests.length, 2);
      assert.ok(
        (fake.state.requests[1]?.at ?? 0) - (fake.state.requests[0]?.at ?? 0) >=
          590,
      );
    } finally {
      chmodSync(env.XDG_CACHE_HOME as string, 0o700);
      await fake.close();
    }
  });

  it('keeps successful output unchanged when neither cache nor temporary storage is writable', async () => {
    const fake = await startFake({ token: 'fake-token' });
    const env = fakeEnv(fake.url, { ITURAN_TOKEN: 'fake-token' });
    const unavailable = join(tempDir(), 'not-a-directory');
    writeFileSync(unavailable, '');
    try {
      const expected = await runBinary(['drivers'], env);
      const actual = await runBinary(['drivers'], {
        ...env,
        XDG_CACHE_HOME: unavailable,
        TMPDIR: unavailable,
      });
      assert.equal(actual.code, 0, actual.stdout);
      assert.equal(actual.stdout, expected.stdout);
    } finally {
      await fake.close();
    }
  });

  it('keeps the successful result and removes the lock when the gap file cannot be written', async () => {
    const fake = await startFake({ token: 'fake-token' });
    const env = fakeEnv(fake.url, { ITURAN_TOKEN: 'fake-token' });
    const dir = join(env.XDG_CACHE_HOME as string, 'ituran-axi');
    mkdirSync(join(dir, 'command.next'), { recursive: true });
    try {
      const result = await runBinary(['vehicles'], env);
      assert.equal(result.code, 0, result.stdout);
      assert.equal(fake.state.requests.length, 1);
      assert.equal(existsSync(join(dir, 'command.lock')), false);
    } finally {
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
