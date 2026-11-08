import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { VERSION } from '../../src/version.ts';

it('VERSION equals package.json', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  assert.equal(VERSION, pkg.version);
});
