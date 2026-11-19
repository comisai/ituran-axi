import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { decode } from '@toon-format/toon';
import { COMMANDS } from '../../src/cli/run.ts';
import { connected } from '../../src/config.ts';
import { Client, isWrite } from '../../src/http.ts';
import { startFake } from '../fake/ituran-fake.ts';
import { fakeEnv, runBinary, tempDir } from '../helpers.ts';

const place = {
  name: 'Depot A',
  place_type: 'Circle',
  point: { latitude: 32.1, longitude: 34.8 },
  radius: 150,
};
const alert = {
  alert_name: 'Night use',
  event_type: 'Ignition',
  alert_contacts: [7, 8],
  license_plates: ['10000001'],
  vehicle_group_ids: [301],
};
const group = {
  vehicle_group_name: 'North',
  license_plates: ['10000001'],
  icon_id: 2,
  parent_group_id: 1,
};
const cases: Array<{
  args: string[];
  method: string;
  path: string;
  body?: unknown;
}> = [
  {
    args: ['place', 'add'],
    method: 'POST',
    path: '/api/v2/places',
    body: place,
  },
  {
    args: ['place', 'edit', '101'],
    method: 'PUT',
    path: '/api/v2/places/101',
    body: place,
  },
  {
    args: ['place', 'remove', '101'],
    method: 'DELETE',
    path: '/api/v2/places/101',
  },
  {
    args: ['alert', 'add'],
    method: 'POST',
    path: '/api/v2/alerts',
    body: alert,
  },
  {
    args: ['alert', 'edit', '201'],
    method: 'PUT',
    path: '/api/v2/alerts/201',
    body: alert,
  },
  {
    args: ['alert', 'remove', '201'],
    method: 'DELETE',
    path: '/api/v2/alerts/201',
  },
  {
    args: ['alert', 'custom', '201'],
    method: 'PUT',
    path: '/api/v2/alerts/custom/201',
    body: { contact_id: 7, is_send_sms: true },
  },
  {
    args: ['alert', 'add', '--plate', '10000001'],
    method: 'POST',
    path: '/api/v2/vehicles/10000001/alerts',
    body: alert,
  },
  {
    args: ['alert', 'edit', '201', '--plate', '10000001'],
    method: 'PUT',
    path: '/api/v2/vehicles/10000001/alerts/201',
    body: { speed_exceeds: 90 },
  },
  {
    args: ['alert', 'remove', '201', '--plate', '10000001'],
    method: 'DELETE',
    path: '/api/v2/vehicles/10000001/alerts/201',
  },
  {
    args: ['group', 'add'],
    method: 'POST',
    path: '/api/v2/vehicle-groups',
    body: group,
  },
  {
    args: ['group', 'edit', '301'],
    method: 'PUT',
    path: '/api/v2/vehicle-groups/301',
    body: group,
  },
  {
    args: ['group', 'members', '301'],
    method: 'PATCH',
    path: '/api/v2/vehicle-groups/301',
    body: { license_plates: { add: ['10000002'], remove: ['10000001'] } },
  },
  {
    args: ['group', 'remove', '301'],
    method: 'DELETE',
    path: '/api/v2/vehicle-groups/301',
  },
];
const doc = (stdout: string) => decode(stdout) as Record<string, unknown>;
const bodyArgs = (body: unknown) =>
  body === undefined ? [] : ['--body', JSON.stringify(body)];

describe('approved record writes', () => {
  it('previews every exact request by default and with --dry-run, without sign-in or account reads', async () => {
    const fake = await startFake();
    try {
      const env = fakeEnv(fake.url, {
        ITURAN_USERNAME: '',
        ITURAN_PASSWORD: '',
      });
      for (const c of cases) {
        for (const flags of [[], ['--dry-run']]) {
          const result = await runBinary(
            [...c.args, ...bodyArgs(c.body), ...flags],
            env,
          );
          assert.equal(result.code, 0, result.stdout);
          assert.equal(result.stderr, '');
          const preview = doc(result.stdout);
          assert.equal(preview.method, c.method);
          assert.equal(
            preview.url,
            `${fake.url.replace('/api/v2', '')}${c.path}`,
          );
          assert.deepEqual(
            preview.body_json === undefined
              ? undefined
              : JSON.parse(String(preview.body_json)),
            c.body,
          );
          assert.match(String(preview.summary), /no request sent/);
        }
      }
      assert.equal(fake.state.requests.length, 0);
      assert.deepEqual(fake.state.grants, { password: 0, refresh: 0 });
    } finally {
      await fake.close();
    }
  });

  it('sends each confirmed route once with the preview body and token, and asks through the Comis catalog', async () => {
    const fake = await startFake({ token: 'fake-token' });
    const entry = JSON.parse(
      readFileSync(
        new URL('../fixtures/comis-ituran-entry.json', import.meta.url),
        'utf8',
      ),
    );
    try {
      for (const c of cases) {
        const env = fakeEnv(fake.url, { ITURAN_TOKEN: 'fake-token' });
        const args = [...c.args, ...bodyArgs(c.body)];
        const preview = doc((await runBinary(args, env)).stdout);
        const before = fake.state.requests.length;
        const result = await runBinary([...args, '--confirm'], env);
        assert.equal(result.code, 0, result.stdout);
        assert.equal(result.stderr, '');
        assert.equal(fake.state.requests.length, before + 1);
        const request = fake.state.requests[before];
        assert.equal(request?.method, c.method);
        assert.equal(request?.path, c.path);
        assert.equal(request?.body, preview.body_json);
        assert.equal(request?.auth, 'Bearer fake-token');
        assert.match(String(doc(result.stdout).summary), /sent once/);
        const template = c.path
          .replace(/\/vehicles\/[^/]+\//, '/vehicles/{plate}/')
          .replace(
            /\/\d+$/,
            c.path.includes('places')
              ? '/{place}'
              : c.path.includes('vehicle-groups')
                ? '/{group}'
                : '/{alert}',
          );
        assert.ok(entry.credential.match.includes(`${c.method} ${template}`));
        assert.equal(
          entry.writes.find(
            (w: { match: string }) => w.match === `${c.method} ${template}`,
          )?.decide,
          'ask',
        );
        if (c.method === 'POST') {
          const response = doc(result.stdout).response as Record<
            string,
            unknown
          >;
          assert.ok(Object.keys(response).some((k) => /_id$/.test(k)));
        }
      }
    } finally {
      await fake.close();
    }
  });

  it('keeps complete long, nested and invisible values identical on the preview and wire', async () => {
    const fake = await startFake({ token: 'fake-token' });
    try {
      const body = {
        ...alert,
        alert_description: `אזור\u202e${'x'.repeat(5000)}`,
        time_filtering: { days: [1, 2], hours: ['22:00', '06:00'] },
        place_alert: { place_id: 101 },
      };
      const file = join(tempDir(), 'body.json');
      writeFileSync(file, JSON.stringify(body));
      const env = fakeEnv(fake.url, { ITURAN_TOKEN: 'fake-token' });
      const args = ['alert', 'edit', '201', '--body', `@${file}`];
      const preview = await runBinary(args, env);
      assert.equal(preview.code, 0, preview.stdout);
      assert.doesNotMatch(preview.stdout, /truncated|withheld/);
      const result = await runBinary([...args, '--confirm'], env);
      assert.equal(result.code, 0, result.stdout);
      assert.equal(fake.state.requests[0]?.body, doc(preview.stdout).body_json);
      assert.deepEqual(JSON.parse(fake.state.requests[0]?.body ?? ''), body);
    } finally {
      await fake.close();
    }
  });

  it('preserves final state when edits, membership patches and deletes are repeated', async () => {
    const fake = await startFake({ token: 'fake-token' });
    try {
      const env = fakeEnv(fake.url, { ITURAN_TOKEN: 'fake-token' });
      for (const c of cases.filter((c) =>
        ['PUT', 'PATCH', 'DELETE'].includes(c.method),
      )) {
        const args = [...c.args, ...bodyArgs(c.body), '--confirm'];
        assert.equal((await runBinary(args, env)).code, 0);
        const first = structuredClone(fake.state.records);
        assert.equal((await runBinary(args, env)).code, 0);
        assert.deepEqual(fake.state.records, first, c.args.join(' '));
      }
    } finally {
      await fake.close();
    }
  });

  it('invalidates the saved-place index after a successful write', async () => {
    const fake = await startFake({ token: 'fake-token' });
    try {
      const env = fakeEnv(fake.url, { ITURAN_TOKEN: 'fake-token' });
      assert.equal((await runBinary(['places', 'Depot'], env)).code, 0);
      const before = fake.state.requests.filter(
        (r) => r.path === '/api/v2/places' && r.method === 'GET',
      ).length;
      assert.equal(
        (
          await runBinary(
            [
              'place',
              'edit',
              '77',
              '--body',
              JSON.stringify(place),
              '--confirm',
            ],
            env,
          )
        ).code,
        0,
      );
      assert.equal((await runBinary(['places', 'Depot'], env)).code, 0);
      assert.equal(
        fake.state.requests.filter(
          (r) => r.path === '/api/v2/places' && r.method === 'GET',
        ).length,
        before + 1,
      );
    } finally {
      await fake.close();
    }
  });

  it('refuses malformed requests, conflicting flags, unsafe numbers and oversized or credential bodies before network I/O', async () => {
    const fake = await startFake();
    try {
      const env = fakeEnv(fake.url);
      for (const args of [
        ['place', 'add'],
        ['group', 'edit'],
        ['alert', 'remove', '../commands/send'],
        ['place', 'add', '5', '--body', '{}'],
        ['group', 'members', '5', '--body', '[]'],
        ['place', 'remove', '5', '--body', '{}'],
        ['place', 'edit', '5', '--body', '{'],
        ['alert', 'custom', '5', '--plate', '10000001', '--body', '{}'],
        ['alert', 'add', '--plate', '../../commands', '--body', '{"x":1}'],
        ['group', 'add', '--body', '{"x":9007199254740993}'],
        ['place', 'add', '--body', '{"x":1e999}'],
        ['place', 'add', '--body', '{"x":1}', '--dry-run', '--confirm'],
        ['place', '77', '--confirm'],
        ['place', '77', '88'],
        ['place', 'edit', '5', '--body', '{"x":1}', '--vehicles'],
        [
          'place',
          'add',
          '--body',
          JSON.stringify({ name: 'Bearer abcdefghijklmnopqrstuvwxyz' }),
        ],
        [
          'place',
          'add',
          '--body',
          JSON.stringify({ name: 'x'.repeat(262144) }),
        ],
        ['group', 'add', '--body', '@/missing/task-body.json'],
      ]) {
        const result = await runBinary(args, env);
        assert.equal(result.code, 2, `${args.slice(0, 3)}: ${result.stdout}`);
        assert.equal(doc(result.stdout).code, 'usage');
        assert.doesNotMatch(result.stdout, /abcdefghijklmnopqrstuvwxyz/);
      }
      assert.equal(fake.state.requests.length, 0);
    } finally {
      await fake.close();
    }
  });

  it('does not retry auth, pressure, server errors or redirects and preserves Ituran error codes and words', async () => {
    for (const status of [400, 401, 403, 429, 481, 503, 307]) {
      const fake = await startFake({
        writeReply: {
          status,
          json: {
            error_code: '1004',
            error_description: 'Radius is out of range.',
          },
        },
      });
      try {
        const result = await runBinary(
          ['place', 'add', '--body', JSON.stringify(place), '--confirm'],
          fakeEnv(fake.url),
        );
        assert.equal(result.code, 1, result.stdout);
        assert.equal(
          fake.state.requests.filter((r) => r.path === '/api/v2/places').length,
          1,
        );
        assert.deepEqual(fake.state.grants, { password: 1, refresh: 0 });
        assert.equal(doc(result.stdout).codes, '1004');
        assert.match(result.stdout, /Radius is out of range/);
      } finally {
        await fake.close();
      }
    }
  });

  it('never retries a write when the response times out after sending', async () => {
    const fake = await startFake({ token: 'fake-token', stall: 'headers' });
    try {
      const env = fakeEnv(fake.url, {
        ITURAN_TOKEN: 'fake-token',
        COMIS_DEADLINE: String(Date.now() + 1800),
      });
      const result = await runBinary(
        ['place', 'add', '--body', JSON.stringify(place), '--confirm'],
        env,
      );
      assert.equal(result.code, 1, result.stdout);
      assert.equal(doc(result.stdout).code, 'unreachable');
      assert.equal(fake.state.requests.length, 1);
    } finally {
      await fake.close();
    }
  });

  it('reports a held action with its wait command, and refuses a denied delete without declaring it absent', async () => {
    for (const [status, refusal] of [
      [409, 'approval_pending'],
      [404, 'policy_refused'],
    ] as const) {
      const fake = await startFake({
        token: 'fake-token',
        writeReply: {
          status,
          headers: { 'comis-refusal': refusal, 'comis-action': 'act_test_123' },
        },
      });
      try {
        const result = await runBinary(
          ['place', 'remove', '101', '--confirm'],
          fakeEnv(fake.url, { ITURAN_TOKEN: 'fake-token' }),
        );
        assert.equal(result.code, 1, result.stdout);
        assert.equal(
          doc(result.stdout).code,
          status === 409 ? 'held_for_approval' : 'refused',
        );
        if (status === 409)
          assert.match(result.stdout, /comis action wait act_test_123/);
        assert.equal(fake.state.requests.length, 1);
        assert.equal(fake.state.effects.length, 0);
      } finally {
        await fake.close();
      }
    }
  });

  it('has no device, driver, contact, drive-share or arbitrary request command', async () => {
    const fake = await startFake();
    try {
      const env = fakeEnv(fake.url);
      for (const command of [
        'command',
        'commands',
        'move',
        'immobilize',
        'unlock',
        'assign-driver',
        'contact',
        'contacts',
        'share-drive',
        'request',
      ]) {
        assert.equal(
          COMMANDS.some((c) => c.name === command),
          false,
        );
        assert.equal((await runBinary([command], env)).code, 2);
      }
      for (const args of [
        ['vehicle', '10000001', '--move'],
        ['driver', '5', '--change'],
        ['alert', 'unlock', '5'],
      ])
        assert.equal((await runBinary(args, env)).code, 2);
      assert.equal(fake.state.requests.length, 0);
    } finally {
      await fake.close();
    }
  });

  it('enforces the transport allowlist before sign-in, rejecting alternate route spellings and versions', async () => {
    const fake = await startFake();
    try {
      const env = fakeEnv(fake.url);
      let headers = 0;
      const client = new Client(
        connected(env),
        {
          header: async () => {
            headers++;
            return '';
          },
          renew: async () => false,
        },
        { fetch, sleep: async () => {} },
        () => new Date(),
      );
      for (const path of [
        '/api/v2/commands/send',
        '/api/v2/contacts',
        '/api/advanced/v1/drivers/assignments',
        '/api/v2/vehicles/10000001/share-drive',
        '/api/v3/places',
        '/api/v2/places/../commands',
        '/api/v2/places%2fcommands',
        '/api/v2/places/1/',
        '/API/V2/places',
        '/api/v2/places;x',
        '/api/v2/drive-permission-group',
      ]) {
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
          assert.equal(isWrite(method, path), false);
          await assert.rejects(
            client.write({ method, path, body: {} }),
            /unsupported write/,
          );
        }
      }
      assert.equal(headers, 0);
      assert.equal(fake.state.requests.length, 0);
    } finally {
      await fake.close();
    }
  });
});
