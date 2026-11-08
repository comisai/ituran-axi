// Check what `npm publish` would ship: only dist/, README.md, LICENSE, NOTICE
// and package.json, a runnable bin with a shebang, the exact TOON pin, and no
// source, tests, docs, fixtures or reports.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const fail = (message) => {
  console.error(`check-package: ${message}`);
  process.exit(1);
};
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const [pack] = JSON.parse(
  execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    encoding: 'utf8',
  }),
);
const files = pack.files.map((f) => f.path).sort();
const allowed = (p) =>
  p === 'package.json' ||
  p === 'README.md' ||
  p === 'LICENSE' ||
  p === 'NOTICE' ||
  /^dist\/[\w/.-]+\.js$/.test(p);
const extra = files.filter((p) => !allowed(p));
if (extra.length) fail(`unexpected files in the package: ${extra.join(', ')}`);
for (const needed of [
  'package.json',
  'README.md',
  'LICENSE',
  'NOTICE',
  'dist/bin/ituran-axi.js',
  'dist/cli/run.js',
]) {
  if (!files.includes(needed))
    fail(`missing ${needed}; run npm run build first`);
}
const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
if (pkg.bin?.['ituran-axi'] !== 'dist/bin/ituran-axi.js')
  fail('bin must be dist/bin/ituran-axi.js');
if (
  JSON.stringify(Object.keys(pkg.dependencies ?? {})) !==
  '["@toon-format/toon"]'
)
  fail('the only runtime dependency must be @toon-format/toon');
if (!/^\d+\.\d+\.\d+$/.test(pkg.dependencies['@toon-format/toon']))
  fail('@toon-format/toon must be pinned exactly');
const bin = readFileSync(
  new URL('../dist/bin/ituran-axi.js', import.meta.url),
  'utf8',
);
if (!bin.startsWith('#!/usr/bin/env node\n'))
  fail('the bin needs a node shebang');
if (
  /from '\.[^']*\.ts'/.test(
    readFileSync(new URL('../dist/cli/run.js', import.meta.url), 'utf8'),
  )
)
  fail('dist still imports .ts files');
const version = execFileSync(
  process.execPath,
  ['dist/bin/ituran-axi.js', '--version'],
  { encoding: 'utf8' },
).trim();
if (version !== pkg.version)
  fail(`the bin prints ${version}, package.json says ${pkg.version}`);
console.log(
  `check-package: ok, ${files.length} files, ${pack.size} bytes packed, version ${version}`,
);
