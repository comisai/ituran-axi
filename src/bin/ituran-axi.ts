#!/usr/bin/env node
import { main } from '../cli/run.ts';
import { defaultDeps } from '../http.ts';

// A reader that closes early, as in `ituran-axi ... | head`, is a normal end.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

process.exitCode = await main(process.argv.slice(2), {
  stdout: (text) => {
    process.stdout.write(text);
  },
  env: process.env,
  now: () => new Date(),
  http: defaultDeps,
});
