import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { withCommandLock } from '../../src/command-lock.ts';
import { tempDir } from '../helpers.ts';

describe('command lock ownership and lease recovery', () => {
  it('rechecks freshness after renaming and restores a lock that became live', async (t) => {
    const env = { XDG_CACHE_HOME: tempDir() };
    const dir = join(env.XDG_CACHE_HOME, 'ituran-axi');
    const lock = join(dir, 'command.lock');
    mkdirSync(dir, { recursive: true });
    const owner = JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      token: 'live-again',
    });
    writeFileSync(lock, owner);
    let calls = 0;
    t.mock.method(process, 'kill', () => {
      if (++calls === 1)
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      return true;
    });
    await assert.rejects(
      withCommandLock(env, Date.now() + 1400, async () => {
        assert.fail('a refreshed lock must not be taken');
      }),
      { code: 'busy' },
    );
    assert.equal(readFileSync(lock, 'utf8'), owner);
    assert.ok(calls > 1, 'liveness was checked again after rename');
  });

  it('treats EPERM during the PID check as a live owner', async (t) => {
    const env = { XDG_CACHE_HOME: tempDir() };
    const dir = join(env.XDG_CACHE_HOME, 'ituran-axi');
    const lock = join(dir, 'command.lock');
    mkdirSync(dir, { recursive: true });
    const owner = JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      token: 'protected-pid',
    });
    writeFileSync(lock, owner);
    t.mock.method(process, 'kill', () => {
      throw Object.assign(new Error('permission'), { code: 'EPERM' });
    });
    await assert.rejects(
      withCommandLock(env, Date.now() + 1400, async () => {
        assert.fail('EPERM is not proof of a dead PID');
      }),
      { code: 'busy' },
    );
    assert.equal(readFileSync(lock, 'utf8'), owner);
  });

  it('does not refresh or remove a replacement owner lock', async () => {
    const env = { XDG_CACHE_HOME: tempDir() };
    const lock = join(env.XDG_CACHE_HOME, 'ituran-axi', 'command.lock');
    const replacement = JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      token: 'replacement-owner',
    });
    await withCommandLock(env, undefined, async () => {
      rmSync(lock);
      writeFileSync(lock, replacement);
      const before = statSync(lock).mtimeMs;
      await sleep(2200);
      assert.equal(
        statSync(lock).mtimeMs,
        before,
        'heartbeat must target its own inode',
      );
    });
    assert.equal(readFileSync(lock, 'utf8'), replacement);
  });

  it('recovers an expired heartbeat from a different host and preserves new ownership', async () => {
    const env = { XDG_CACHE_HOME: tempDir() };
    const dir = join(env.XDG_CACHE_HOME, 'ituran-axi');
    const lock = join(dir, 'command.lock');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      lock,
      JSON.stringify({
        pid: process.pid,
        hostname: 'other-host',
        token: 'expired-owner',
      }),
    );
    const old = new Date(Date.now() - 11_000);
    utimesSync(lock, old, old);
    const result = await withCommandLock(env, Date.now() + 1800, async () => {
      const owner = JSON.parse(readFileSync(lock, 'utf8'));
      assert.equal(owner.hostname, hostname());
      assert.notEqual(owner.token, 'expired-owner');
      return 'done';
    });
    assert.equal(result, 'done');
    assert.equal(existsSync(lock), false);
  });
});
