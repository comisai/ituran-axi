# Contributing to ituran-axi

Thank you for helping. This guide covers how to set up the project, what a good change looks like, and how changes are reviewed.

## Before you start

- **Bugs:** open an [issue](https://github.com/comisai/ituran-axi/issues) with the command, its output and what you expected.
- **Features and larger changes:** open an issue first, so we can agree on the approach before you write code.
- **Security problems:** do not open a public issue. Follow [SECURITY.md](SECURITY.md).
- **Real data:** never paste passwords, tokens, plates, driver names, positions or addresses into issues, pull requests, tests or fixtures. Replace them with placeholders.

## Setup

You need Node.js 22.18 or later. Node runs the TypeScript sources directly, so tests need no build step.

```sh
git clone https://github.com/comisai/ituran-axi.git
cd ituran-axi
npm ci
npm run check       # type-check, lint, unit and contract tests
npm run build       # dist/bin/ituran-axi.js
npm run test:dist   # contract and AXI-principle tests against the built CLI
```

`npm run format` formats the code with Biome.

## Project layout

| Path | What it holds |
| --- | --- |
| `src/cli/` | Argument parsing, dispatch, and the command table that drives parsing, `--help` and usage lines |
| `src/commands/` | The commands, one module per area: `vehicles`, `trips`, `drivers`, `places`, `catalog`, `readings`, `reports`, `centers` and the home view |
| `src/output/` | TOON rendering, size bounds and text safety |
| `src/http.ts`, `src/pace.ts`, `src/errors.ts` | Read-only requests, request pacing, and the error codes |
| `src/auth.ts`, `src/config.ts`, `src/account.ts` | Settings, sign-in and the token cache, and the account and its time zone |
| `src/time.ts`, `src/plates.ts`, `src/geo.ts`, `src/json.ts` | Time windows and zones, plate keys, distances, and integers above 2^53 |
| `test/unit/`, `test/contract/` | Unit tests, and end-to-end tests of the CLI against a fake Ituran |
| `test/axi/` | The ten AXI principles, checked against the CLI |
| `test/fake/` | The fake Ituran server the tests use |
| `test/live/` | Opt-in, read-only checks against the real Ituran API |
| `test/fixtures/` | A copy of the Comis Gate's `ituran` service, which the contract and live tests check the AXI's requests against |
| `docs/` | Design, implementation plan, master plan, and the recipes for common questions |

## What a good change looks like

ituran-axi is used by AI agents, so its output is part of its interface. Follow these rules. `test/axi/principles.test.ts` checks most of them.
- **Output:** results go to stdout as TOON, starting with a summary line. Output stays within the size limits unless `--full` is given.
- **Hints:** the `help[N]:` footer is a TOON list, one `- ` item per line, so the whole output decodes as one TOON document. `helpBlock` in `src/output/toon.ts` writes it. Each hint starts with ``Run `ituran-axi …` ``.
- **Errors:** an error prints `message`, `code` and `usage` on stdout. The exit code is 1 for an error and 2 for a usage error. Reuse an existing code before adding a new one.
- **Read-only:** ituran-axi never changes Ituran settings or sends a command to a vehicle. `src/http.ts` refuses any request that is not a read: a GET, or a POST to a route listed in `READ_POSTS`.
- **Secrets:** a password or token never appears in output, errors or logs.
- **Data from Ituran is untrusted.** Names, notes and event titles are written by people. They go through the text-safety layer in `src/output/text.ts`. Write invisible or bidirectional characters in source as `\u` escapes, never as literal characters.
- **Personal data:** positions, addresses and driver names stay inside the connection. Phone numbers and e-mail addresses appear only with `--full` or `--fields`.
- **Dependencies:** the only runtime dependency is `@toon-format/toon`, pinned exactly. Discuss any new dependency in an issue first.
- **Wording:** messages, help and docs use short, plain English sentences.

Add or update tests with every change. When the fake needs to model new Ituran behaviour, extend `test/fake/ituran-fake.ts`, and write down in the pull request what the real API does. When behaviour changes, update the README, the `--help` text and the recipes; if the Comis `ituran-read` skill (in the Comis repository, `images/packs/apps/skills/ituran-read/`) needs a change, say so in the pull request.

## Live tests

`test/live/ituran-live.mjs` checks the real Ituran API. It is read-only by construction: its one HTTP helper refuses anything but reads and the sign-in grant. Run it with `--help` to see its stages and options. It needs your own Ituran account:
- **Credentials:** copy `test/live/.env.example` to `test/live/.env.local`, fill it in, and run `node --env-file=test/live/.env.local test/live/ituran-live.mjs`. Git ignores these files. Never commit credentials.
- **Sign-ins:** Ituran blocks addresses that sign in repeatedly (HTTP 474). Run the live test sparingly. To rerun without signing in, set `ITURAN_TOKEN` to a valid token.
- **Reports:** reports in `test/live/reports/` keep only statuses, counts and value shapes. They stay local and are not committed.

Continuous integration never runs the live tests.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep each pull request to one topic.
3. Run `npm run check`, `npm run build` and `npm run test:dist`. Continuous integration runs the same checks on Node 22 and 24.
4. Fill in the pull request template: what changed, why, and how you tested it.

`main` is protected. Every change goes through a pull request whose checks pass, and a maintainer squash-merges it.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
