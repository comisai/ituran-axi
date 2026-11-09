// The recipes in docs/recipes.md name only commands the AXI has.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { COMMANDS } from '../../src/cli/run.ts';

it('the recipes name only real commands', () => {
  const recipes = readFileSync(
    new URL('../../docs/recipes.md', import.meta.url),
    'utf8',
  );
  const names = new Set(COMMANDS.map((c) => c.name));
  const used = [...recipes.matchAll(/(?:`|^)ituran-axi ([a-z][a-z-]*)/gm)];
  assert.ok(used.length > 5, 'the recipes name commands');
  for (const m of used)
    assert.ok(names.has(m[1] as string), `unknown command ${m[1]}`);
});
