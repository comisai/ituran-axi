# ituran-axi

[![CI](https://github.com/comisai/ituran-axi/actions/workflows/ci.yml/badge.svg)](https://github.com/comisai/ituran-axi/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ituran-axi.svg)](https://www.npmjs.com/package/ituran-axi)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A read-only command-line tool that lets AI agents read Ituran vehicle tracking: vehicles and their positions, trips, drivers, saved places, events, alerts, sensor readings, reports and safety grades.

ituran-axi is an AXI, an [agent experience interface](https://axi.md). Every command:
- prints compact [TOON](https://github.com/toon-format/toon) text on stdout, bounded in size;
- refuses bad input and says exactly what is wrong;
- ends with hints for the next command, as a TOON list, so the whole output decodes as one document;
- only reads. It never changes Ituran settings or sends commands to a vehicle.

It replaces [`ituran-mcp`](https://github.com/ituranlabs/ituran-mcp) for agents that have a shell: 24 commands instead of 152 tool schemas, which cost about 43,000 tokens per conversation. It was built to run inside Comis, behind the Comis Gate, and it also works on its own.

> **Status:** early development (0.x). Every command is tested end to end against the production Ituran API.

## Requirements

- Node.js 22.18 or later.
- An Ituran fleet account with API access. Use a service account without two-step sign-in.

## Install

```sh
npm install -g ituran-axi
```

Each release is published from GitHub Actions with [npm provenance](https://docs.npmjs.com/generating-provenance-statements), so you can check that it was built from this repository. To run from source instead, see [Development](#development).

## Configure

| Variable | Meaning |
| --- | --- |
| `ITURAN_USERNAME`, `ITURAN_PASSWORD` | The account to sign in with |
| `ITURAN_TOKEN` | A bearer token, used instead of a username and password. Inside Comis this is the Gate's placeholder, and nothing else is set. |
| `ITURAN_URL` | The API root. The default is `https://api.ituran.com/api/v2`. `ITURAN_GLOBAL_BASE_URL`, the name `ituran-mcp` uses, also works. |

**Sign-in is cached.** Ituran blocks addresses that sign in again and again (HTTP 474), and a command-line tool runs once per command. So ituran-axi keeps the token in `~/.local/state/ituran-axi/` (directory mode 0700, file mode 0600), reuses it for its lifetime, and refreshes it. `ituran-axi logout` deletes it. With `ITURAN_TOKEN` set, ituran-axi never signs in.

## Usage

```text
ituran-axi                                  home view: account, time zone, vehicles, next steps
ituran-axi vehicles [<text>]                list, or find by plate digits, name, make or model
ituran-axi vehicle <plate>                  last position with address, current driver, saved places
ituran-axi where [<plate>...] [--all] [--stale 2h] [--near <lat,lon> [--within <km>]]
ituran-axi trips [<plate>...] [window]      trips, matched by their end time
ituran-axi trip <id> [--points] [--safety] [--speeding]
ituran-axi totals [<plate>] [window]        trip totals for the account or one vehicle
ituran-axi odometer <plate>... | --all      GPS odometer estimates with their reliability
ituran-axi centers [--near <plate|lat,lon>] Ituran service centers, nearest first
ituran-axi drivers [<text>] | driver <id>
ituran-axi places [<text>] | place <id> [--vehicles]
ituran-axi groups [<id>]
ituran-axi events [--all] | event <id>      event states, and the vehicles in each now
ituran-axi alerts [--plate <plate>]         alert definitions
ituran-axi diagnostics <plate>... | --all [--names a,b] [--history --date <d>]
ituran-axi report daily|periodic|idle [<plate>...] [--drivers] [window]
ituran-axi report speed|events|engine|full|diagnostics|heat-map <plate>... [window] [--over <km/h>]
ituran-axi safety [totals|vehicles|drivers|groups|periodic|ubi-vehicles|ubi-drivers] [window]
ituran-axi maintenance [<plate>] [--types]
ituran-axi temps [current|history <plate>|breaches]
ituran-axi logout
ituran-axi help [<command>]                 every flag of a command
```

A **window** is `--since 90m|24h|7d`, `--from <t> [--to <t>]`, or `--date YYYY-MM-DD`. Times are local to the account's time zone, which the home view shows, and take the form `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm`. **Lists** take `--limit`, `--page`, `--fields` and `--full`.

```console
$ ituran-axi where --limit 3
summary: 13 vehicles · 9 parking · 4 driving · 1 last seen over 24h ago
zone: Asia/Jerusalem
vehicles[3]{plate,age,status,speed,address}:
  "12345678",3m,driving,62,"0 Example Street, Tel Aviv"
  "23456789",3m,parking,0,"1 Example Street, Tel Aviv"
  "34567890",3m,parking,0,"2 Example Street, Tel Aviv"
help[3]:
  - Run `ituran-axi where --all --page 2 --limit 3` for the next 3
  - Run `ituran-axi vehicle <plate>` for one vehicle's driver and saved places
  - Run `ituran-axi trips <plate> --since 24h` for where it went

$ ituran-axi vehicle 00000000
message: "Ituran found no vehicle 00000000: Entity was not found license_plate: 00000000"
code: not_found
usage: "ituran-axi vehicle <plate> [--full]"
```

[`docs/recipes.md`](docs/recipes.md) has tested shell combinations for common questions about the vehicles.

### Ituran's own rules

ituran-axi handles these, and says so in its output where it matters:
- Trips are matched by their end time, and appear up to a few hours after they end.
- Ituran fails a month of trips for the whole account in one request. ituran-axi reads a window longer than 7 days a week at a time, newest week first, and joins the pages.
- BI reports ignore plate filters, so ituran-axi filters them itself.
- Operational reports take at most 5 plates and less than 3 days per request. ituran-axi splits the request, walks the pages and removes repeated rows.
- Alert lists repeat rows, which are removed and counted.
- Keypad driver codes above 2^53 stay exact.
- A model year or odometer of 0 means "not set".

## Output and errors

- **Size:** a value is cut at 500 characters and the whole output at about 4,000. `--full` lifts both limits, up to 256 KB.
- **Text safety:** invisible and bidirectional control characters are shown as `\uXXXX`, and values that look like credentials are withheld.
- **Personal data:** phone numbers and e-mail addresses appear only with `--full` or `--fields`.
- **Errors** print `message`, `code` and `usage` on stdout.
- **Exit codes:** 0 on success, 1 on an error, 2 on a usage error.

| Code | Meaning |
| --- | --- |
| `usage` | The command line is wrong; `usage` shows the right form |
| `not_connected` | No token, and no username and password |
| `auth_failed`, `two_step_required` | Ituran refused the sign-in, or asked for a second step |
| `access_blocked` | Ituran blocked this address (HTTP 474). Do not retry. |
| `not_visible`, `not_found`, `not_tracked` | The plate or record is not in this account, or Ituran keeps no trips for it |
| `not_entitled`, `feature_off`, `needs_app_id` | This account does not include that service |
| `rejected` | Ituran refused the request; its message is shown |
| `rate_limited`, `ituran_error`, `unreachable` | Ituran limited the request, failed, or could not be reached |
| `reconnect_needed`, `refused` | Inside Comis: the owner must reconnect, or the Gate refused |
| `output_too_large` | Even `--full` would exceed 256 KB; narrow the query |
| `internal_error` | A bug in ituran-axi; please [report it](https://github.com/comisai/ituran-axi/issues) |

## Comis

Comis ships `ituran-axi` in its `apps` pack, with the `ituran-read` skill and the `ituran` Gate service in its own repository. Inside Comis, the Gate signs in to Ituran and holds the token, and the agent's workbench never sees the password or the token. [`test/fixtures/comis-ituran-entry.json`](test/fixtures/comis-ituran-entry.json) is a copy of that Gate service; `test/contract/gate-entry.test.ts` checks that every request the AXI sends gets the token as a read, and that sign-in, device commands and writes are denied.

## Development

```sh
git clone https://github.com/comisai/ituran-axi.git && cd ituran-axi
npm ci
npm run check       # type-check, lint, unit and contract tests against a fake Ituran
npm run build       # dist/bin/ituran-axi.js
npm run test:dist   # contract and AXI-principle tests against the built CLI
npm link            # optional: put this build on your PATH as ituran-axi
```

The live tests against the real Ituran API are opt-in, read-only, and need your own account; see [CONTRIBUTING.md](CONTRIBUTING.md#live-tests). The design and plans are in [`docs/`](docs/ituran-axi-design.md).

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first, and follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately, as described in [SECURITY.md](SECURITY.md).

## License

MIT; see [LICENSE](LICENSE). Third-party notices are in [NOTICE](NOTICE).

Ituran is a trademark of Ituran Location and Control Ltd. This project is not affiliated with or endorsed by Ituran.
