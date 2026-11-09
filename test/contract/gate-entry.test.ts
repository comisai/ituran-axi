// The Comis Gate's ituran entry against the AXI itself: every request
// ituran-axi sends must get the token and pass as a read, and the identity
// routes, device commands and writes must be denied. The fixture is a copy of
// the ituran entry in Comis's catalog/key-services.json; update it when either
// side changes. The matcher
// follows the Gate's rules: paths only, {name} matches one segment of
// [A-Za-z0-9._~-]+, {a|b} matches one listed literal, {name...} the rest.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { startFake } from '../fake/ituran-fake.ts';
import { fakeEnv, runBinary } from '../helpers.ts';

interface Entry {
  hosts: string[];
  credential: { oauth?: string; inject: string; match: string[] };
  reads: string[];
  writes: Array<{ match: string; decide: string }>;
  variable: string;
}

const entry = JSON.parse(
  readFileSync(
    new URL('../fixtures/comis-ituran-entry.json', import.meta.url),
    'utf8',
  ),
) as Entry;
const SEG = /^[A-Za-z0-9._~-]+$/;

function segment(p: string, s: string): boolean {
  if (p.startsWith('{') && p.endsWith('}')) {
    const inner = p.slice(1, -1);
    return inner.includes('|') ? inner.split('|').includes(s) : SEG.test(s);
  }
  return p === s;
}

function pathMatch(pattern: string, path: string): boolean {
  if (pattern === '*') return true;
  const ps = pattern.split('/').slice(1);
  const xs = path.split('/').slice(1);
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i] as string;
    if (/^\{[A-Za-z_]+\.\.\.\}$/.test(p))
      return (
        i === ps.length - 1 &&
        xs.length > i &&
        xs.slice(i).every((s) => SEG.test(s))
      );
    if (i >= xs.length || !segment(p, xs[i] as string)) return false;
  }
  return ps.length === xs.length;
}

function rule(r: string, method: string, path: string): boolean {
  const [m = '', p = ''] = r.split(' ');
  return (m === '*' || m === method) && pathMatch(p, path);
}

export function judge(
  method: string,
  path: string,
): { credentialed: boolean; decide: string } {
  const credentialed = entry.credential.match.some((r) =>
    rule(r, method, path),
  );
  if (['GET', 'HEAD', 'OPTIONS'].includes(method))
    return { credentialed, decide: 'read' };
  if (entry.reads.some((r) => rule(r, method, path)))
    return { credentialed, decide: 'read' };
  return {
    credentialed,
    decide:
      entry.writes.find((w) => rule(w.match, method, path))?.decide ?? 'deny',
  };
}

let fake: Awaited<ReturnType<typeof startFake>>;
before(async () => {
  fake = await startFake({ token: 'placeholder-token' });
});
after(() => fake.close());

describe('Comis Gate entry', () => {
  it('names the service the way the Gate and the skill expect', () => {
    assert.deepEqual(entry.hosts, ['api.ituran.com']);
    assert.equal(entry.credential.inject, 'bearer');
    assert.equal(entry.variable, 'ITURAN_TOKEN');
    assert.equal(entry.writes.at(-1)?.match, '* *');
    assert.equal(entry.writes.at(-1)?.decide, 'deny');
  });

  it('credentials every request the AXI sends, as a read', async () => {
    const env = {
      ...fakeEnv(fake.url),
      ITURAN_TOKEN: 'placeholder-token',
      ITURAN_USERNAME: '',
      ITURAN_PASSWORD: '',
    };
    const commands = [
      [],
      ['vehicles', '1234'],
      ['vehicles', 'Corolla'],
      ['vehicle', '12345678'],
      ['where', '--all'],
      ['where', '12345678'],
      ['trips', '12345678', '--date', '2026-11-07'],
      ['trip', '5000', '--points', '--safety', '--speeding'],
      ['totals', '--date', '2026-11-07'],
      ['totals', '12345678', '--date', '2026-11-07'],
      ['odometer', '--all'],
      ['drivers', 'D1'],
      ['driver', '500'],
      ['places', 'Depot'],
      ['place', '77', '--vehicles'],
      ['groups'],
      ['groups', '1'],
      ['events'],
      ['event', '11'],
      ['alerts'],
      ['alerts', '--plate', '12345678'],
      ['diagnostics', '12345678'],
      ['diagnostics', '12345678', '--history', '--date', '2026-11-07'],
      ['report', 'daily', '--date', '2026-11-07'],
      ['report', 'idle', '--drivers', '--date', '2026-11-07'],
      ['report', 'events', '12345678', '--date', '2026-11-07'],
      ['report', 'heat-map', '12345678', '--date', '2026-11-07'],
      ['safety', '--date', '2026-11-07'],
      ['safety', 'vehicles', '--date', '2026-11-07'],
      ['safety', 'ubi-drivers', '--date', '2026-11-07'],
      ['maintenance'],
      ['maintenance', '12345678'],
      ['maintenance', '--types'],
      ['temps'],
      ['centers', '--near', '12345678'],
      ['where', '--near', '32.10,34.78', '--within', '5'],
      ['diagnostics', '--all'],
      ['safety', 'groups', '--date', '2026-11-07'],
      [
        'safety',
        'periodic',
        '--by',
        'month',
        '--from',
        '2026-09-01',
        '--to',
        '2026-10-31',
      ],
    ];
    const before = fake.state.requests.length;
    for (const args of commands) await runBinary(args, env);
    const seen = fake.state.requests.slice(before);
    assert.ok(seen.length >= commands.length);
    const bad = [...new Set(seen.map((r) => `${r.method} ${r.path}`))].filter(
      (key) => {
        const [method = '', path = ''] = key.split(' ');
        const v = judge(method, path);
        return !(v.credentialed && v.decide === 'read');
      },
    );
    assert.deepEqual(bad, []);
    assert.ok(
      seen.every((r) => r.path !== '/api/v1/oauth/token'),
      'token mode never signs in',
    );
  });

  it('denies the token route, device commands, contacts and every write', () => {
    for (const [method, path] of [
      ['POST', '/api/v1/oauth/token'],
      ['POST', '/api/v2/commands/send'],
      ['POST', '/api/v2/commands/start-tracking'],
      ['POST', '/api/v2/commands/update-keyboard'],
      ['POST', '/api/v2/vehicles/12345678/share-drive'],
      ['POST', '/api/v2/places'],
      ['PUT', '/api/v2/places/1'],
      ['DELETE', '/api/v2/alerts/1'],
      ['PATCH', '/api/v2/vehicle-groups/1'],
      ['PUT', '/api/v2/users/me/password'],
      ['POST', '/api/v2/drive-permission-group'],
      ['POST', '/api/v2/contacts'],
      ['POST', '/api/v2/push-notifications/alerts/search'],
    ] as const) {
      assert.equal(judge(method, path).decide, 'deny', `${method} ${path}`);
    }
    for (const path of [
      '/api/v1/oauth/token',
      '/api/v2/contacts',
      '/api/v2/drive-permission-group',
      '/swagger/global-v2/v2/swagger.json',
    ]) {
      assert.equal(judge('GET', path).credentialed, false, path);
    }
  });
});
