// The binary must leave its stdout open for whoever shares it. A caller that
// spawns a shell with piped stdio gives it a socketpair, and ending stdout on a
// socket shuts down writing for every process sharing that socket.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';
import { startFake } from '../fake/ituran-fake.ts';
import { BIN, fakeEnv } from '../helpers.ts';

type Result = {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
};

/** Run with piped stdio, as a Comis worker does; optionally hold off reading. */
function runPiped(
  command: string,
  args: string[],
  env: Record<string, string>,
  holdMs = 0,
): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    if (holdMs > 0) {
      child.stdout.pause();
      setTimeout(() => child.stdout.resume(), holdMs);
    }
    const guard = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.on('close', (code, signal) => {
      clearTimeout(guard);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/** The binary, then a later command writing to the same stdout, in one shell. */
function inShell(args: string[], env: Record<string, string>) {
  return runPiped(
    'bash',
    ['-c', '"$AXI_NODE" "$AXI_BIN" "$@"; echo after', 'shell', ...args],
    { ...env, AXI_NODE: process.execPath, AXI_BIN: BIN },
  );
}

describe('stdout shared through a socket', () => {
  it('leaves stdout writable after --version', async () => {
    const r = await inShell(['--version'], {});
    assert.equal(r.code, 0, JSON.stringify(r));
    assert.match(r.stdout, /after\n$/, JSON.stringify(r));
    assert.doesNotMatch(r.stderr, /write error/, r.stderr);
  });

  it('leaves stdout writable after the home view', async () => {
    const fake = await startFake();
    try {
      const r = await inShell([], fakeEnv(fake.url));
      assert.equal(r.code, 0, JSON.stringify(r));
      assert.match(r.stdout, /^account: /m);
      assert.match(r.stdout, /after\n$/, JSON.stringify(r));
      assert.doesNotMatch(r.stderr, /write error/, r.stderr);
    } finally {
      await fake.close();
    }
  });

  it('delivers large output completely before exiting', async () => {
    const fake = await startFake({
      placeCount: 500,
      placeDescription: 'd'.repeat(350),
    });
    try {
      const r = await runPiped(
        process.execPath,
        [BIN, 'places', '--limit', '500', '--full'],
        fakeEnv(fake.url),
        300,
      );
      assert.equal(r.code, 0, r.stdout.slice(-500));
      assert.ok(
        Buffer.byteLength(r.stdout) > 160 * 1024,
        `only ${Buffer.byteLength(r.stdout)} bytes`,
      );
      const tail = r.stdout.slice(-300);
      assert.ok(r.stdout.startsWith('summary: 500 saved places\n'), tail);
      assert.ok(r.stdout.includes('\n  10499,Site 499,Area,ddd'), tail);
      assert.ok(r.stdout.endsWith('\n'), tail);
    } finally {
      await fake.close();
    }
  });
});
