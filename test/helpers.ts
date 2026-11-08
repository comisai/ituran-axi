import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ituran-axi-test-'));
}

/** The binary under test: dist when ITURAN_AXI_BIN=dist, else the TypeScript source. */
export const BIN =
  process.env.ITURAN_AXI_BIN === 'dist'
    ? new URL('../dist/bin/ituran-axi.js', import.meta.url).pathname
    : new URL('../src/bin/ituran-axi.ts', import.meta.url).pathname;

/** Run the binary as a separate process with only the given environment and closed stdin. */
export function runBinary(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [BIN, ...args],
      { env: { PATH: process.env.PATH ?? '', ...env } },
      (error, stdout, stderr) => {
        resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr });
      },
    );
    child.stdin?.end();
  });
}

/** Settings for a fresh, private run against the fake. */
export function fakeEnv(
  url: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const home = tempDir();
  return {
    ITURAN_URL: url,
    ITURAN_USERNAME: 'user_a',
    ITURAN_PASSWORD: 'secret-pass',
    HOME: home,
    XDG_STATE_HOME: join(home, 'state'),
    XDG_CACHE_HOME: join(home, 'cache'),
    ...extra,
  };
}
