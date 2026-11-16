#!/usr/bin/env node
import { main } from '../cli/run.ts';
import { defaultDeps } from '../http.ts';

// A reader that closes early, as in `ituran-axi ... | head`, is a normal end.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

const code = await main(process.argv.slice(2), {
  stdout: (text) => {
    process.stdout.write(text);
  },
  env: process.env,
  now: () => new Date(),
  http: defaultDeps,
});

// Node's environment-proxy dispatcher can keep a CONNECT socket alive even
// after fetch has aborted. This is a one-command process: once cleanup has
// finished and stdout has drained, exit to release the dispatcher and sockets.
// Setting only exitCode leaves that socket holding the process open.
process.stdout.end(() => process.exit(code));
