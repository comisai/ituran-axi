# ituran-axi

A command-line tool for AI agents to read Ituran vehicle tracking: vehicles and their last positions, trips, drivers, saved places, event states, alerts, sensor readings, reports and safety grades. It is an AXI (agent experience interface, axi.md):
- It prints short TOON text on stdout.
- It refuses bad input and names what was wrong.
- It ends with hints for the next command.
- It only reads.

It replaces `ituran-mcp` for agents with a shell. It has 24 commands instead of 152 tool schemas, which cost about 43,000 tokens per conversation. It is built to run inside Comis, behind the Comis Gate, and it also works on its own.

**Status:** every command is qualified live on a production account. `test/live/ituran-live.mjs --strict --deep --parity --use-cases` passes, including the 126 owner questions of `ituran-mcp`'s `docs/USER-PROMPTS.md`. The Comis Gate changes it needs are in review: comisai/comis#3617 and comisai/comis#3630. See `docs/ituran-axi-master-plan.md`.

## Settings

| Variable | Meaning |
| --- | --- |
| `ITURAN_TOKEN` | A bearer token. Inside Comis, this is the Gate's placeholder, and nothing else is set. |
| `ITURAN_USERNAME`, `ITURAN_PASSWORD` | Outside Comis: a service account without two-step sign-in |
| `ITURAN_URL` | The API root. The default is `https://api.ituran.com/api/v2`. `ITURAN_GLOBAL_BASE_URL`, `ituran-mcp`'s name, also works. |

**Outside Comis, the token is cached.** With a username and password, the token lives in `~/.local/state/ituran-axi/`, in a directory of mode 0700 and a file of mode 0600. It is reused for its day and then refreshed. Ituran's access protection blocks addresses that sign in again and again (HTTP 474), and a command-line tool runs once per command. `ituran-axi logout` deletes the cache.

**Inside Comis, it never signs in.** With `ITURAN_TOKEN` set, the AXI never calls the identity routes.

## Commands

```text
ituran-axi                                  home view: account, zone, vehicles, next steps
ituran-axi vehicles [<text>]                list, or find by plate digits, name, make or model
ituran-axi vehicle <plate>                  last position with address, current driver, saved places
ituran-axi where [<plate>...] [--all] [--stale 2h] [--near <lat,lon> [--within <km>]]
ituran-axi trips [<plate>...] [--since 24h | --from <t> [--to <t>] | --date <d>]
ituran-axi trip <id> [--points] [--safety] [--speeding]
ituran-axi totals [<plate>] [window]        trip totals for the account or one vehicle
ituran-axi odometer <plate>... | --all      GPS odometer estimates with their reliability
ituran-axi centers [--near <plate|lat,lon>]        Ituran service centers, nearest first
ituran-axi drivers [<text>] | driver <id>
ituran-axi places [<text>] | place <id> [--vehicles]
ituran-axi groups [<id>]
ituran-axi events [--all] | event <id>      event states and the vehicles in each now
ituran-axi alerts [--plate <plate>]         alert definitions
ituran-axi diagnostics <plate>... | --all [--names a,b] [--history --date <d>]
ituran-axi report daily|periodic|idle [<plate>...] [--drivers] [window]
ituran-axi report speed|events|engine|full|diagnostics|heat-map <plate>... [window] [--over <km/h>]
ituran-axi safety [totals|vehicles|drivers|groups|periodic [--by day|month]|ubi-vehicles|ubi-drivers] [window]
ituran-axi maintenance [<plate>] [--types]
ituran-axi temps [current|history <plate>|breaches]
ituran-axi logout
ituran-axi help [<command>]
```

**Lists.** Lists take `--limit`, `--page`, `--fields` and `--full`.

**Times.** Times are local to the account's zone, which the home view shows. Windows take one of these forms:
- `--since 90m|24h|7d`
- `--from` and `--to`, as `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm`
- `--date YYYY-MM-DD`

The AXI turns a window into the form each route takes.

**Ituran's own rules are handled and stated:**
- Trips are matched by their end time and appear hours late.
- BI reports ignore plate filters, so ituran-axi filters them itself.
- Operational reports take at most 5 plates and less than 3 days per request, and page with an inclusive cursor. ituran-axi splits and walks them, removing repeated rows.
- Alert lists repeat rows, which are removed and counted.
- Keypad driver codes above 2^53 stay exact.
- A model year or odometer of 0 means "not set".

`comis/skills/ituran/recipes.md` shows shell combinations for common questions.

## Output and errors

Output is TOON on stdout.
- **Bounds.** A field is cut at 500 code points with its size, and the whole output at about 4,000 characters. `--full` lifts both, up to 256 KB.
- **Text safety.** Hidden bidirectional and zero-width characters are shown as `\uXXXX`. Values that look like credentials are withheld.
- **Personal data.** Phone numbers and e-mail addresses appear only with `--full` or `--fields`.

An error prints `message`, `code` and `usage` on stdout. The exit code is 0 on success, 1 on an error and 2 on a usage error.

| Code | Meaning |
| --- | --- |
| `usage` | The command line is wrong |
| `not_connected` | No token, and no username and password |
| `auth_failed`, `two_step_required` | Ituran refused the sign-in, or asked for a second step |
| `access_blocked` | Ituran's access protection blocked this address (HTTP 474). Do not retry. |
| `reconnect_needed`, `refused` | Inside Comis: the Gate asks the owner to reconnect, or refused the request |
| `not_visible`, `not_found`, `not_tracked` | The plate or record is not in this account, or Ituran keeps no trips for it |
| `not_entitled`, `feature_off`, `needs_app_id` | This account does not include that service |
| `rejected` | Ituran refused the request; its message is shown |
| `rate_limited`, `ituran_error`, `unreachable` | Ituran limited, failed, or could not be reached |
| `output_too_large`, `internal_error` | Even `--full` would be too large, or a bug |

## Comis

`comis/` holds the connector bundle:
- the Gate service entry
- the `ituran` skill and its recipes
- the pack wrapper
- drafts of the two Gate decisions it needs

See `comis/README.md`. The design is in `docs/ituran-axi-design.md`.

## Development

```sh
npm ci
npm run check        # typecheck, lint, unit, contract, Comis bundle and AXI-principle tests
npm run build        # dist/bin/ituran-axi.js
npm run test:dist    # the same tests against the built package
node --env-file=test/live/.env.prod test/live/ituran-live.mjs --strict --deep --parity --use-cases   # live; see the implementation plan §7.1
```

The only runtime dependency is `@toon-format/toon`, pinned exactly. It needs Node 22.18 or later.

## License

MIT; see `LICENSE`. Third-party notices are in `NOTICE`. Ituran is a trademark of Ituran Location and Control Ltd; this project is not made or endorsed by Ituran.
