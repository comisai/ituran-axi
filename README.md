# ituran-axi

[![CI](https://github.com/comisai/ituran-axi/actions/workflows/ci.yml/badge.svg)](https://github.com/comisai/ituran-axi/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ituran-axi.svg)](https://www.npmjs.com/package/ituran-axi)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A command-line tool that lets AI agents read Ituran vehicle tracking: vehicles and their positions, trips, drivers, saved places, events, alerts, sensor readings, reports and safety grades. It can also create, change and delete saved places, alerts and vehicle groups.

ituran-axi is an AXI, an [agent experience interface](https://axi.md). Every command:
- prints compact [TOON](https://github.com/toon-format/toon) text on stdout, bounded in size;
- refuses bad input and says exactly what is wrong;
- ends with hints for the next command, as a TOON list, so the whole output decodes as one document;
- previews every write unless `--confirm` is given. It never sends a device command, changes a driver, writes a contact or shares a drive.

It replaces [`ituran-mcp`](https://github.com/ituranlabs/ituran-mcp) for agents that have a shell: compact commands instead of 152 tool schemas, which cost about 43,000 tokens per conversation. It was built to run inside Comis, behind the Comis Gate, and it also works on its own.

> **Status:** early development (0.x). Reads have been checked against production. Writes are proved on fakes only; the QA-account run waits for the owner. See each pull request for validation coverage.

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
ituran-axi trips [window] --by plate        one row per vehicle: trips, km, km a day, top speed
ituran-axi trip <id> [--points] [--safety] [--speeding]
ituran-axi totals [<plate>] [window]        trip totals for the account or one vehicle
ituran-axi odometer <plate>... | --all      GPS odometer estimates with their reliability
ituran-axi centers [--near <plate|lat,lon>] Ituran service centers, nearest first
ituran-axi drivers [<text>] | driver <id>
ituran-axi places [<text>] | place <id> [--vehicles]
ituran-axi place add|edit|remove [<id>] [--body <JSON|@file>] [--dry-run|--confirm]
ituran-axi alert add|edit|remove|custom [<id>] [--plate <plate>] [--body <JSON|@file>] [--dry-run|--confirm]
ituran-axi group add|edit|members|remove [<id>] [--body <JSON|@file>] [--dry-run|--confirm]
ituran-axi groups [<id>] [--vehicles]
ituran-axi events [--all] | event <id>      event states, and the vehicles in each now
ituran-axi alerts [--plate <plate>]         alert definitions
ituran-axi diagnostics <plate>... | --all [--names a,b] [--history --date <d>] [--page N]
ituran-axi report daily|periodic|idle [<plate>...] [--drivers] [window]
ituran-axi report speed|events|engine|full|diagnostics|heat-map <plate>... [window] [--over <km/h>]
ituran-axi safety [totals|vehicles|drivers|groups|periodic|ubi-vehicles|ubi-drivers] [window]
ituran-axi maintenance [<plate>] [--types]
ituran-axi temps [current|history <plate>|breaches]
ituran-axi logout
ituran-axi help [<command>]                 every flag of a command
```

Position fields include `age_seconds` alongside the rounded `age`, plus `driver_id`, `groups` and `group_ids`. Select them with `where --fields` or `vehicles --fields`; `vehicle` includes the age in `position` and a `groups` list. `age_seconds` converts the timestamp using the account zone's offset at that time, so it measures elapsed seconds across DST changes; negative values indicate future timestamps. Repeated fall-back times and nonexistent spring-forward times return `null` because they have no unique instant. The rounded `age` retains its existing wall-clock display.

`groups <id>` requests the member plates Ituran lists for that group. `groups --vehicles` includes counts and plates throughout the tree. `report daily|periodic|idle --group <id>` filters by those plates and adds `group_km` for all matching rows before output paging. Membership is current. Child-group lists are not merged, and whether the parent's plate list includes descendants remains unverified until a live run. These reads cannot reconstruct historical membership. Group totals are `null` if the report walk is partial or member report rows or distance fields are missing. `group_reported_vehicles` and `group_unreported_vehicles` show that coverage. The coverage rule assumes a BI row per member. Whether BI omits stationary vehicles and whether idle rows carry distance are unverified until a live run; conservative totals may remain `null`. Fleet-wide idle totals are omitted when filtering to plates or a group.

`report events|full <plate>... --place <id> [window]` reads dated saved-place evidence, including place IDs and names. It requires explicit plates. Records do not establish complete arrival/departure times or continuous visits. `events --all` shows current states, including empty ones; use `report events` for history. `report speed` requires `--over <km/h>`.

`maintenance` preserves its existing columns and adds `next.date`, `next.odometer` and `next.engine_hours` when present. `without_due_target` counts records with no date or positive odometer/engine-hours target. Missing targets do not mean overdue. `diagnostics --page N --limit N` pages the readings after all vehicle pages have been read; each reading retains its own age. Pages re-read current data and can shift between calls. `--full` lifts output size bounds, while `--limit` and `--page` still control rows.

A **window** is `--since 90m|24h|7d`, `--from <t> [--to <t>]`, or `--date YYYY-MM-DD`. Times are local to the account's time zone, which the home view shows, and take the form `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm`. Ituran answers only up to the present, so a window ends at most 2 minutes ago: an end given with `--to` or `--date` that is later is cut there, and the output's `clamped` line names the end asked for. Whole-day windows end today instead. **Lists** take `--limit`, `--page`, `--fields` and `--full`.

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

[`docs/round2-gaps.md`](docs/round2-gaps.md) records the API evidence and remaining limits. [`docs/recipes.md`](docs/recipes.md) has tested shell combinations for common questions about the vehicles.

### Change a place, alert or vehicle group

`add` creates a record and takes no ID. `edit` changes the numeric ID you name; send the full body Ituran expects for that change. `remove <id>` sends no body. `group members <id>` patches membership. `alert ... --plate <plate>` uses that vehicle's alert route. `alert custom <id>` changes how an alert tells an existing contact and takes no `--plate`.

Give the request as `--body '{...}'` or `--body @request.json`. Every body field is sent as provided, including nested objects and arrays; nothing is inferred from a saved record or silently omitted. Use these field names:

| Record | Body fields |
| --- | --- |
| Place | `name`, `description`, `place_type`, `point`, `points`, `radius`, `width`, `layer_id`. A circle uses `point: {"latitude": ..., "longitude": ...}` and `radius`. |
| Alert | `alert_name`, `alert_description`, `event_type`, `alert_status`, `always_on`, `time_filtering`, `alert_contacts`, `license_plates`, `vehicle_group_ids`, `speed_exceeds`, `place_alert`. Contacts must already exist in the account. |
| Custom alert | `contact_id`, `is_send_push`, `is_send_sms`, `is_send_email` |
| Vehicle group | `vehicle_group_id`, `vehicle_group_name`, `icon_id`, `parent_group_id`, `license_plates` |
| Membership patch | `license_plates: {"add": ["10000002"], "remove": ["10000001"]}` |

Ituran validates which fields a particular record needs. IDs above JavaScript's safe integer range must be quoted JSON strings. An invalid JSON body is refused locally.

```sh
ituran-axi place add --body '{"name":"Depot A","place_type":"Circle","point":{"latitude":32.1,"longitude":34.8},"radius":150}' --dry-run
ituran-axi group members 301 --body '{"license_plates":{"add":["10000002"],"remove":["10000001"]}}' --dry-run
```

The default and `--dry-run` print the method, URL and complete `body_json`, with no sign-in or network request. `body_json` is the exact request body, with non-ASCII characters represented by JSON escapes. In Comis, an owner card above about 4,000 characters is refused even if the local preview fits. Previews are never shortened or masked: a body that looks like a credential or a preview above 256 KB is refused. Replace `--dry-run` with `--confirm` to send the same request once. Confirmation is explicit and never prompts. In Comis, the write still waits for the owner's card; a held action returns `held_for_approval` and `comis action wait <id>`. Do not submit it again.

Writes never retry, refresh authentication after a refusal, or follow redirects. Edits and membership patches set the requested state; an explicit plain record-not-found code `404` on removal succeeds with `already_absent: true` and preserves its HTTP status and Ituran's words. Other 404 codes, including an unknown vehicle, remain errors. Creates have no upstream idempotency key: repeating a confirmed `add` can create another record. A timeout, connection drop or server failure says the write may have been applied or may still be waiting for the owner's card. Do not repeat it: check `comis action list` or read the account first. A 401 drops a matching cached token without signing in again or replaying the write. A create's receipt includes its new ID; errors preserve Ituran's code and description. Receipts print only allowed IDs and result fields, with bounded output. An incomplete result (`result: false` or failed vehicles) exits 1 with `write_incomplete`, a failed-vehicle count and at most 20 plate keys. Echoed contacts and their names, phones and emails are omitted. Successful place writes clear the local place-name index.

Device commands, including moving, immobilizing or unlocking a vehicle and changing its driver, are never available. Contact writes and drive sharing are also unavailable. No confirmation flag enables them.

### Ituran's own rules

ituran-axi handles these, and says so in its output where it matters:
- Trips are matched by their end time, and appear up to a few hours after they end. A trip belongs to the window it ends in; the output's `matched` line says so.
- Ituran can list a trip still under way, with a provisional end at the moment of the request, past the window's end. `trips` and `trips --by plate` list and count only trips that end inside the window they print; the `left_out` line names the trips left out. Pages run over Ituran's list, those trips included: a page that is not the whole list says `N of up to M trips`, a page that keeps none says `none on page P of Q` with the hint for the next page, and only a page holding the whole list gives an exact count and km. `totals <plate>` shows Ituran's own figures, which are not checked trip by trip, and says so when the window ends within the last few hours.
- Operational reports (`report events`, `report full` and the others with records) list only records stamped inside the window, and the `left_out` line counts any others Ituran sent.
- Ituran fails a month of trips for the whole account in one request. ituran-axi reads a window longer than 7 days a week at a time, newest week first, and joins the pages. `trips --by plate` reads every trip of the window this way and sums them per vehicle.
- BI reports ignore plate filters, so ituran-axi filters them itself.
- Operational reports take at most 5 plates and less than 3 days per request. ituran-axi splits the request, walks the pages and removes repeated rows.
- Alert lists repeat rows, which are removed and counted.
- Keypad driver codes above 2^53 stay exact.
- A model year or odometer of 0 means "not set".

Commands for the same host user run their HTTP requests one command at a time, including sign-in. Requests within a command keep the existing limit of two in flight, starting at least 400 ms apart. The next command waits at least 400 ms after the previous command finishes. The command lock is `/tmp/ituran-axi-<uid>/command.lock`, independent of `TMPDIR`, `HOME` and `XDG_CACHE_HOME`. Set `ITURAN_AXI_LOCK_DIR` to override its directory. Wrappers with separate filesystem namespaces must set this to the same writable directory shared by every command; keep it stable across accounts and tokens. A busy lock returns `busy` without sending a request. Wait for the other command to finish before trying again.

The lock records its owner's PID, hostname and a random token. The holder refreshes its heartbeat every two seconds. A dead PID on the same host, or a heartbeat missing for ten seconds, permits automatic recovery. Release checks the owner token, so an old holder cannot remove a replacement lock. If the selected lock directory is unavailable, reads continue without a process lock, with the same output. Cleanup errors never replace a successful result. Separate users and hosts need external coordination; the gap between commands also depends on writable lock storage.

Reads have a 25-second overall budget; confirmed writes have 55 seconds to accommodate the Comis Gate's 45-second card hold. Each budget includes lock waiting, sign-in, pacing and requests (plus retries and pages for reads). Lock contention waits at most 30 seconds and uses up part of the command budget, so it can leave less time for a card. `COMIS_DEADLINE` can shorten this budget, with a one-second margin for output and cleanup. HTTP requests and sign-in also have individual timeouts (60 and 30 seconds), shortened to the remaining command budget. Timeouts cover the response body, abort the request and cancel the body. The CLI flushes its error and exits, releasing Node's proxy dispatcher sockets even if a proxy has not answered CONNECT.

`trips` accepts at most 56 days per command, including `--by plate`. Longer ranges return a usage error before any trip requests. Split them into shorter windows. `--limit` limits output rows; calculating the exact count still reads each weekly window. This bound keeps counts, page hints and totals consistent for accepted windows.

## Output and errors

- **Size for reads:** a value is cut at 500 characters and the whole output at about 4,000. `--full` lifts both limits, up to 256 KB.
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
| `busy` | Another local command holds the process lock. Wait for it to finish before trying again. |
| `write_incomplete` | Ituran did not complete the write; inspect the account and the failed-vehicle count before making another change |
| `held_for_approval` | The write waits for the owner; run the printed `comis action wait` command and do not retry |
| `reconnect_needed`, `refused` | Inside Comis: the owner must reconnect, or the Gate refused |
| `output_too_large` | Even `--full` would exceed 256 KB; narrow the query |
| `internal_error` | A bug in ituran-axi; please [report it](https://github.com/comisai/ituran-axi/issues) |

## Comis

Comis ships `ituran-axi` in its `apps` pack, with the `ituran-read` skill and the `ituran` Gate service in its own repository. Inside Comis, the Gate signs in to Ituran and holds the token, and the agent's workbench never sees the password or the token. [`test/fixtures/comis-ituran-entry.json`](test/fixtures/comis-ituran-entry.json) is a copy of that Gate service; `test/contract/gate-entry.test.ts` checks read credentials and the denied device, driver, contact and sign-in routes. The write contract tests check that all 14 record writes get credentials and require an owner card. Connections made before these writes stay read-only until the owner runs `comis disconnect ituran`, then `comis connect ituran`. The Comis client pin and `ituran-write` skill follow this release in a separate Comis change.

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
