import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { expiresAt, sessionFor, tokenDir } from '../../src/auth.ts';
import { type Auth, readSettings, type Settings } from '../../src/config.ts';
import type { AxiError } from '../../src/errors.ts';
import { defaultDeps } from '../../src/http.ts';
import { startFake } from '../fake/ituran-fake.ts';
import { tempDir } from '../helpers.ts';

let fake: Awaited<ReturnType<typeof startFake>>;
before(async () => {
  fake = await startFake();
});
after(() => fake.close());

const settingsFor = (url: string, password = 'secret-pass') =>
  readSettings({
    ITURAN_URL: url,
    ITURAN_USERNAME: 'user_a',
    ITURAN_PASSWORD: password,
  }) as Settings & { auth: Auth };

describe('sign-in', () => {
  it('reads expires_in as minutes, and a JWT exp when there is one', () => {
    assert.equal(expiresAt('opaque', 1440, 0), 1440 * 60_000);
    const jwt = `x.${Buffer.from(JSON.stringify({ exp: 100 })).toString('base64url')}.y`;
    assert.equal(expiresAt(jwt, 1440, 0), 100_000);
  });

  it('caches one token for many commands, privately', async () => {
    const env = { XDG_STATE_HOME: tempDir() };
    const s = settingsFor(fake.url);
    const before = fake.state.grants.password;
    const a = await sessionFor(s, defaultDeps, env, () => new Date()).header();
    const b = await sessionFor(s, defaultDeps, env, () => new Date()).header();
    assert.equal(a, b);
    assert.equal(fake.state.grants.password - before, 1);
    const dir = tokenDir(s, 'user_a', env);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, 'token.json')).mode & 0o777, 0o600);
  });

  it('shares one grant between parallel commands', async () => {
    const env = { XDG_STATE_HOME: tempDir() };
    const s = settingsFor(fake.url);
    const before = fake.state.grants.password;
    const headers = await Promise.all(
      Array.from({ length: 4 }, () =>
        sessionFor(s, defaultDeps, env, () => new Date()).header(),
      ),
    );
    assert.equal(new Set(headers).size, 1);
    assert.equal(fake.state.grants.password - before, 1);
  });

  it('refreshes a token near its end instead of signing in again', async () => {
    const env = { XDG_STATE_HOME: tempDir() };
    const s = settingsFor(fake.url);
    const first = await sessionFor(
      s,
      defaultDeps,
      env,
      () => new Date(),
    ).header();
    const file = join(tokenDir(s, 'user_a', env), 'token.json');
    const cached = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(
      file,
      JSON.stringify({ ...cached, expires_at: Date.now() + 60_000 }),
    );
    const refreshes = fake.state.grants.refresh;
    const second = await sessionFor(
      s,
      defaultDeps,
      env,
      () => new Date(),
    ).header();
    assert.notEqual(first, second);
    assert.equal(fake.state.grants.refresh - refreshes, 1);
  });

  it('names a wrong password, a two-step account and a blocked address', async () => {
    const env = { XDG_STATE_HOME: tempDir() };
    await assert.rejects(
      sessionFor(
        settingsFor(fake.url, 'wrong'),
        defaultDeps,
        env,
        () => new Date(),
      ).header(),
      (e: AxiError) =>
        e.code === 'auth_failed' &&
        !/IncorrectUserNameOrPassword/.test(e.message),
    );
    const twoStep = await startFake({ twoStep: true });
    await assert.rejects(
      sessionFor(
        settingsFor(twoStep.url),
        defaultDeps,
        { XDG_STATE_HOME: tempDir() },
        () => new Date(),
      ).header(),
      (e: AxiError) => e.code === 'two_step_required',
    );
    await twoStep.close();
    const blocked = await startFake({ blocked: true });
    await assert.rejects(
      sessionFor(
        settingsFor(blocked.url),
        defaultDeps,
        { XDG_STATE_HOME: tempDir() },
        () => new Date(),
      ).header(),
      (e: AxiError) => e.code === 'access_blocked',
    );
    await blocked.close();
  });

  it('sends a token as it is and never calls the identity routes', async () => {
    const s = readSettings({
      ITURAN_URL: fake.url,
      ITURAN_TOKEN: 'placeholder-token',
    }) as Settings & { auth: Auth };
    const before = fake.state.requests.length;
    assert.equal(
      await sessionFor(s, defaultDeps, {}, () => new Date()).header(),
      'Bearer placeholder-token',
    );
    assert.equal(fake.state.requests.length, before);
  });
});
