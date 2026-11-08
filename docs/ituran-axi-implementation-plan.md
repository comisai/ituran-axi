# ituran-axi: implementation plan

| | |
| --- | --- |
| Status | M2, M3 and M4 done on 2026-11-08. Every read command is built, tested (57 tests) and passes the live gate on production. Release waits on Q5; Comis custody waits on C1 and C2 (master plan §8). |
| Date | 2026-11-08 |
| Design | `ituran-axi-design.md` |
| Master plan | `ituran-axi-master-plan.md` |
| Live test | `test/live/ituran-live.mjs` |

## 1. Summary

This plan breaks the design into tasks you can build and test. It starts from three live runs against the owner's production account, made on 2026-11-08 and read-only by construction.

**What works on the live account:**
- sign-in, with both the password and refresh grants
- every read family the AXI needs: vehicles, positions, trips, drivers, places, groups, events, alerts, diagnostics, BI and operational reports, safety, maintenance
- the draft Comis Gate entry: it credentials every read the run made, and denies the token route, device commands and writes

**What this account cannot read:**
- ITC temperatures (`1006`)
- advanced alerts (403)
- event types (`1032`)
- drive-permission groups (`403.2`)

These become clear error codes, not failures.

**What is blocked:**
- Writes. There is no QA account and no authorization, and the first release does not write.
- Comis custody. It needs the Gate change C1, a password-grant connection, and C2, which keeps Ituran's 403s. Both need decision records.

None of that blocks the AXI. It is built against a fake Ituran that copies what production returns, and the live test is the referee.

## 2. Production check, 2026-11-08

Target: `https://api.ituran.com/api/v2`, the owner's production service account. Command:

```sh
node --env-file=test/live/.env.prod test/live/ituran-live.mjs --deep --parity
```

| Stage | Result | Evidence |
| --- | --- | --- |
| S1 config | pass | Production detected; identity root derived as `/api/v1` |
| S2 reach | pass | TLS with Node's own CA store. **No `Authorization` gets 400**, `{error_code: "BadRequest", error_description: "Autorization header not found. (IdSP)"}`, not 401. Server `openresty`. |
| S3 sign in | pass | Password grant in 170 to 790 ms. Opaque 88-character bearer, `expires_in: 1440`, meaning minutes. Refresh token present. An unknown user gets 401 `IncorrectUserNameOrPassword`, in JSON and form-encoded alike. |
| S4 token | pass | The token reads `users/me`. A made-up token gets 401 with no challenge header. A refresh rotates both tokens, and **the old access token still works**. |
| S5 account | pass | Zone `Israel Standard Time`, mapped to `Asia/Jerusalem`. `permissions` holds 194 web-interface capability names, not API scopes. `users/me` echoes no token. |
| S6 entitlements | pass | 22 families probed (design §2.3): 16 available; ITC and advanced not entitled; event types need an app id; drive-permission groups are off; exports are empty |
| S7 paging | pass | Paging at `metadata.pagination` (`page_number, page_size, total_count, page_count`). Drivers use top-level `pagination`. A `page_size` of 5 or 2,001 gets 400 `1000`. Plates are 7 or 8 digits. |
| S8 errors | pass | An unknown plate gets 403 `1020`. An unknown route gets 404 with an empty body. A missing parameter gets 400 `1000` with `errors[]`. |
| S9 vehicle reads | pass | Detail, location (`location.point`), driver, batch location, search, trips for 3 days, trip stats, last diagnostics, virtual odometer, command catalog, one trip with its points, vehicles inside a place |
| S9b deep reads | pass | Trip safety, heat map, events report, diagnostics history, event drill-down, BI daily drivers, safety per vehicle |
| S10 transport | pass | 48 to 58 requests, p50 74 to 177 ms, no 429, 474 or 481. `br` and `gzip`. No rate-limit headers. Large integers present. Hundreds of Hebrew strings. |
| S11 AXI smoke | pass | 26 runs of the built `ituran-axi` with the run's token, covering every command family. Each exits as expected, prints the expected TOON, stays under 4,000 characters, and writes nothing to stderr. |
| S12 MCP parity | pass | `ituran-mcp@4.2.0` read-only, with the vehicles and users families: 8 tools, and the same vehicle total as the direct read |
| S13 Gate rules | pass | 43 distinct routes. Each one ituran-axi uses is credentialed and passes as a read. The token route gets no token and is denied. Device commands, share-drive, user settings and every write are denied. `test/contract/comis-bundle.test.ts` checks the same entry against every request the AXI itself sends. |

### 2.1 Findings that changed the design

All of these are in `ituran-axi-design.md`.

| # | Finding | Change |
| --- | --- | --- |
| F1 | `expires_in` is minutes (1440 = 24 h), and the old token survives a refresh | The token cache keeps one token for a day. The Gate proposal (C1) reads minutes. A refresh never breaks a command already running. |
| F2 | Repeated password grants trip HTTP 474 (`ituran-mcp`), and a CLI runs once per command | Outside Comis, a private token cache with a lock gives about one grant a day. Inside Comis, the Gate signs in. New error `access_blocked`. |
| F3 | No `Authorization` gets 400, not 401 | `not_connected` is decided locally, before any request. A 400 `BadRequest` from `IdSP` is never shown as "rejected". |
| F4 | 403 means "not in this account" (`1020`), "not entitled" (`1006`, empty body) or "feature off" (`403.2`), never bad credentials | Error codes `not_visible`, `not_entitled` and `feature_off`. The Gate change C2 keeps 403 for this service. |
| F5 | The token route parses form bodies as well as JSON | C1 can use the Gate's existing OAuth client, which sends forms. |
| F6 | `trips/totals` refuses a time in its bounds ("date should be only date without time") | The time module knows each route's date form. `totals` sends date-only bounds. |
| F7 | `users/me` permissions are web-interface capability names | The home view cannot predict entitlements. It lists families met as unavailable, from the account cache, and never probes. |
| F8 | `GET /places/{id}/vehicles` takes 2 s to over 60 s | `place --vehicles` warns first and is bounded by the deadline. Q7 considers computing it from positions and geometry. |
| F9 | Contacts are readable but hold people's phone numbers and addresses | Not read and not credentialed (design §5.1) |
| F10 | Plates are digits, 7 or 8 long | A plate always fits one path segment. Input is normalized and checked locally. |
| F11 | Node trusts the production TLS chain | No CA launcher. `ituran-mcp`'s `start.js` is dropped. |
| F12 | `realtime_fields=LastLocation\|Driver\|Places` on `GET /vehicles`, `GET /vehicles/{plate}` and `POST /vehicles/search` returns the position with its address, the driver and the saved places in one read | `vehicle` is one request. `where --all` is one or two. `place --vehicles` uses the place lists, which answers Q7. The batch-location route is not needed. |
| F13 | BI reports and safety grades refuse `page_size` above 1,000 ("must be between 1 and 1000"); other routes take 2,000 | Those commands cap `--limit` at 1,000 and page at 1,000. Found by running the skill's recipes live. |
| F14 | The idle report nests rows in `idle.idle_items`, beside `idle.idle_total` | The rows are read from there, and the total is shown. The fake copies the shape. |
| F15 | Batch location now returns a top-level `pagination` block, which `ituran-mcp` did not see | Recorded as drift. The AXI does not use the route. |
| F16 | Default output stops at about 4,000 characters, so a pipeline over every row needs `--full` | The skill's recipes use `--full` and say why. |
| F17 | A unit test found `Date.UTC` rolling 2026-13-01 over into 2027 | `naiveMs` refuses dates that do not survive the round trip. |

## 3. Build order

1. **Runtime core.** The command table, strict parsing, TOON output with bounds, text safety and the closed error set. Copied from `priority-axi`, which follows the Comis AXI fixture, and adapted.
2. **Ituran core.** Settings, plates, time windows, large integers, the HTTP client with its read-only allowlist, pacing, and the token cache. Ported from `ituran-mcp` where it has the knowledge.
3. **A fake Ituran.** A `node:http` server that answers as production does (§2): sign-in, envelopes, paging, the error shapes, and the 474 and 481 answers.
4. **Commands over the fake.** The core reads first: home, `vehicles`, `vehicle`, `where`, `trips`, `trip`, `drivers`, `places`, `help`. Then the rest.
5. **Live qualification.** S11 runs the built binary against production with the run's token, and `--parity` compares against `ituran-mcp`.
6. **Release, then Comis.** Master plan M5 to M8.

## 4. Repository layout

```text
ituran-axi/
  package.json                  bin ituran-axi; type module; engines node >=22.18
  tsconfig*.json, biome.json    as priority-axi
  docs/                         design, implementation plan, master plan
  comis/
    key-services/ituran.json    the draft Gate entry (live S13 checks it)
  src/
    bin/ituran-axi.ts           argv -> command -> exit code (0 ok, 1 error, 2 usage)
    cli/table.ts                the one command table: args, flags, summaries
    cli/parse.ts                strict parseArgs; refusals name the flag, never its value
    cli/run.ts                  home, help, version, dispatch, error record
    config.ts                   ITURAN_TOKEN | ITURAN_USERNAME+PASSWORD; ITURAN_URL; deadline
    auth.ts                     password and refresh grants; token cache with a lock
    http.ts                     fetch; GET and listed read POSTs only; one retry on 429/481/503
    pace.ts                     two in flight, starts 400 ms apart, stops at the deadline
    errors.ts                   closed code set; classify(answer) -> AxiError
    json.ts                     JSON.parse that keeps integers above 2^53 as strings
    plates.ts                   normalize and check plates
    time.ts                     zones, --since/--from/--to/--date, route date forms, ages, durations
    account.ts                  users/me, zone, families met as unavailable; derived cache
    output/toon.ts              encoder, help footer, field cut, 4,000-unit bound, --full
    output/text.ts              visible escapes, credential withholding
    commands/*.ts               home, vehicles, vehicle, where, trips, trip, drivers, places, ...
  test/
    fake/ituran-fake.ts         the fake Ituran
    helpers.ts
    unit/*.test.ts              node:test
    contract/*.test.ts          the built binary against the fake
    axi/principles.test.ts      the ten principles
    live/ituran-live.mjs        live qualification (exists)
    live/.env.example
```

**Dependencies:**
- **Runtime:** `@toon-format/toon` 4.4.0, pinned exactly. No AXI SDK (D240: `axi-sdk-js` brings self-update and hook installers, validates no flags, and pins an old encoder).
- **Development:** `typescript`, `@biomejs/biome` and `@types/node`, at priority-axi's versions.

## 5. Module contracts

```ts
type Settings = {
  url: string;                       // API root, default https://api.ituran.com/api/v2
  auth: { kind: 'token'; token: string } | { kind: 'password'; user: string; password: string };
  deadline?: number;                 // epoch ms from COMIS_DEADLINE
};
function readSettings(env: NodeJS.ProcessEnv): Settings;   // throws not_connected | usage

interface Session {                  // auth.ts
  header(): Promise<string>;         // 'Bearer …' from ITURAN_TOKEN or the cache
  rejected(header: string): Promise<boolean>; // after a 401: true when a fresh token is worth one retry
}

type Read = { method: 'GET'; path: string; query?: Query } | { method: 'POST'; path: ReadPost; body: unknown; query?: Query };
function request(read: Read, deps: HttpDeps): Promise<Answer>;   // never sends anything else

type ErrorCode = 'usage' | 'not_connected' | 'auth_failed' | 'two_step_required' | 'access_blocked'
  | 'reconnect_needed' | 'refused' | 'not_visible' | 'not_entitled' | 'feature_off' | 'needs_app_id'
  | 'not_found' | 'not_tracked' | 'rejected' | 'rate_limited' | 'ituran_error' | 'unreachable'
  | 'output_too_large' | 'internal_error';
function classify(answer: Answer, ctx: { plate?: string; what?: string }): AxiError | null;

function window(flags: { since?: string; from?: string; to?: string; date?: string }, zone: string, now: Date,
                form: 'naive' | 'date'): { from: string; to: string; note?: string };
function normalizePlate(raw: string): string;    // throws usage when it cannot fit one path segment
function parseJson(text: string): unknown;       // integers >= 2^53 become strings
```

**The classifier, tried in order:**
1. A `Comis-Refusal` header gives `reconnect_needed` or `refused`.
2. 474 gives `access_blocked`.
3. 401 gives `auth_failed`, after one fresh-token retry in password mode.
4. 403: `1020` gives `not_visible`; `403.2` gives `feature_off`; anything else gives `not_entitled`.
5. 400: `1032` gives `needs_app_id`; anything else gives `rejected`.
6. 404: `404.1` on trips gives `not_tracked`; a route that uses 404 for "none" gives an empty state; anything else gives `not_found`.
7. 429 or 481 gives `rate_limited`, after one retry.
8. 5xx gives `ituran_error`.
9. A network failure or timeout gives `unreachable`.

## 6. Work breakdown

Sizes are working days for one developer. "Live" says whether the task needs the Ituran account.

### 6.0 Progress, 2026-11-08

| Tasks | State | Evidence |
| --- | --- | --- |
| T1 to T13 (M2) | **Done** | `npm run check`: typecheck, lint and 57 tests (unit, contract, Comis bundle, AXI principles). `npm run test:dist` against the built package. Live S11 passes. |
| T14 to T19 (M3) | **Done** | Every command in design §7 runs against the fake and, in S11, against production. `temps` is built, but this account answers `not_entitled`, so it stays unqualified until an entitled account exists. |
| T20 | **Done** | S11 covers 26 runs. `--parity` (S12) compares vehicle totals with `ituran-mcp@4.2.0`. Per-command parity cases remain. |
| T21 (M4) | **Done** | `ituran-live --strict --deep --parity`: 14 of 14 stages pass. The report is in `test/live/reports/`. |
| T22 | **Done** | `README.md`, `NOTICE` with the port credit, and `--help` reviewed (overview under 2,000 characters, each command under 1,500) |
| T23, T24 (M5) | Waiting | The repository `comisai/ituran-axi` exists and is private. npm provenance needs it public (master plan V1). |
| T25 | **Done** | `comis/`: catalog entry, skill and recipes (each recipe run live), wrapper, README. Checked by `test/contract/comis-bundle.test.ts`. |
| T26 | **Done** | `comis/decisions.md`: the C1 and C2 drafts with their failure-mode tests |


### M2: core reads on the fake

| ID | Task | Output and test | Size | Depends | Live |
| --- | --- | --- | --- | --- | --- |
| T1 | Scaffold: package, tsconfig, biome, CI, exact pins, `node:test` | `npm run check` passes | 0.25 | — | no |
| T2 | Runtime core from priority-axi: table, parse, run, TOON output, text safety | Unit tests: strict flags, help, bounds, escapes | 0.5 | T1 | no |
| T3 | `config.ts`: token or password, URL default and the `ITURAN_GLOBAL_BASE_URL` alias, `COMIS_DEADLINE` | Unit tests, including a malformed deadline (usage) and an expired one | 0.25 | T1 | no |
| T4 | `errors.ts`: the closed set and the classifier, from the live shapes in §2 | One unit test per code | 0.5 | T1 | no |
| T5 | `json.ts`, `plates.ts`, `time.ts`: large integers, plates, Windows zones, windows per route, ages, both duration forms | Unit tests with naive local times and a zone that is not UTC | 1 | T1 | no |
| T6 | `http.ts` and `pace.ts`: read allowlist, headers, deadline timeouts, one retry, the two-worker gate | Unit tests: a write is refused before any I/O; starts are 400 ms apart; a walk stops at the deadline | 0.75 | T3, T4 | no |
| T7 | `auth.ts`: grants, the minutes expiry, the two-step shape, the 0600 cache, rename on write, the lock, refresh then password fallback, one retry after 401 | Unit tests, including two parallel commands that make one grant | 1 | T6 | no |
| T8 | Fake Ituran: identity (password, refresh, unknown user, two-step, 474), `users/me`, vehicles with paging, location, driver, batch location, search, trips with paging and `404.1`, trip and points, drivers (top-level paging), places; the errors `1020`, `1006`, `403.2`, `1032`, `1000`; 481; slow routes | Self-tests; its answers match §2 | 1.5 | T5 | no |
| T9 | `account.ts` and the home view | Contract: connected, not connected, a blocked IP | 0.5 | T7, T8 | no |
| T10 | `vehicles` and `vehicle` | Contract tests | 0.75 | T9 | no |
| T11 | `where` (plates, `--all`, `--stale`, summary counts) | Contract tests, including the batch route's missing total | 0.5 | T10 | no |
| T12 | `trips` and `trip` (`--points`, `--safety`, `--speeding`), `drivers`, `places` | Contract tests: empty-state wording, the end-time note | 1 | T10 | no |
| T13 | AXI principles test against the built binary; live S11 | Passes; S11 passes on production | 0.5 | T9–T12 | yes |

### M3: the remaining reads

| ID | Task | Output and test | Size | Depends | Live |
| --- | --- | --- | --- | --- | --- |
| T14 | `totals` (date-only bounds) and `odometer` (body paging) | Contract tests | 0.5 | T12 | no |
| T15 | `driver`, `place` (slow-route warning), `groups` | Contract tests | 0.5 | T12 | no |
| T16 | `events` and `event`; `alerts` with repeated rows removed (the fired-alert search is dropped, design §5.1) | Contract tests | 0.75 | T12 | no |
| T17 | `diagnostics` (the 1-day history limit) and `maintenance` (404 as empty) | Contract tests | 0.5 | T12 | no |
| T18 | `report`: BI daily, periodic and idle; operational reports with the cursor, repeated-row removal, and the 5-plate and 3-day splits | Contract tests: a split walk and a deadline cut | 1.5 | T6, T12 | no |
| T19 | `safety` and `temps` (`temps` is unqualified until an entitled account exists) | Contract tests | 0.5 | T12 | no |
| T20 | Extend live S11 to every command, and add `--parity` cases that compare each command with its `ituran-mcp` tool | S11 and S12 pass on production | 0.5 | T14–T19 | yes |

### M4 and M5: qualification and release

| ID | Task | Output and test | Size | Depends | Live |
| --- | --- | --- | --- | --- | --- |
| T21 | `ituran-live --strict --deep --parity` on production; archive the report summary | All stages pass | 0.25 | T20 | yes |
| T22 | README, a plain-English review of `--help`, NOTICE with the `ituran-mcp` port credit | Review done | 0.5 | T21 | no |
| T23 | Release workflow with `npm publish --provenance`; check it as Comis's `axi-publishers` does | `npm view ituran-axi` shows provenance | 0.5 | T22, Q5 | no |
| T24 | Tag 0.1.0 and rerun the live test against the published package | S1 to S13 pass | 0.25 | T23 | yes |

### Comis bundle (prepared here, landed in master plan M7)

| ID | Task | Output and test | Size | Depends | Live |
| --- | --- | --- | --- | --- | --- |
| T25 | `comis/`: catalog entry (exists), skill `ituran` and recipes, wrapper, `hardening.md` with the C1 and C2 proposals | A bundle test like priority-axi's: every AXI request matches the entry; the skill names only real commands | 1 | T19 | no |
| T26 | Drafts of the C1 and C2 decision records for the Comis maintainers | Two documents with failure-mode test lists | 0.5 | — | no |

**Total for M2 to M5:** about 14 working days for one developer. The live runs are quarter days.

## 7. Test plan

| Layer | What it proves | Where | When | Needs |
| --- | --- | --- | --- | --- |
| Unit | Pure modules | `test/unit` | Every commit, in CI | nothing |
| Contract | The built binary against the fake: every command and error code; only GETs and listed read POSTs on the wire; one grant for many commands | `test/contract` | Every commit, in CI | nothing |
| AXI principles | The ten principles (design §3.2) | `test/axi` | Every commit, in CI | nothing |
| **Live** | Production behaves as the fake assumes, and the AXI works end to end | `test/live/ituran-live.mjs` | Each milestone gate, each release, weekly while building, and after Ituran changes anything | The account. Never in public CI. |
| Comis proofs | Gate custody, reconnect, refusals | Comis `tests/integration/connectors` | M7 | The Comis repository |

### 7.1 The live test

`test/live/ituran-live.mjs` has no dependencies and needs Node 22 or later. It prints TOON and writes a JSON report to `test/live/reports/`, which is gitignored.

| Stage | Proves | Guards |
| --- | --- | --- |
| S1 config | Settings present, `https`, root `/api/vN`, identity derived, environment detected | `not_connected` |
| S2 reach | DNS, TLS and the no-`Authorization` answer (400) | `unreachable`, F3, F11 |
| S3 sign in | The password grant, the token's form and lifetime, an unknown user (401), the form-encoded parse | `auth_failed`, `two_step_required`, F1, F5 |
| S4 token | The token works, a made-up token gets 401, refresh rotation, the old token after a refresh | F1, the token cache |
| S5 account | `users/me` keys, the zone mapping, the permission names, and no token echoed | Home view, F7 |
| S6 entitlements | One read per family, classified | `not_entitled`, `feature_off`, `needs_app_id`, the empty states |
| S7 paging | Paging block and keys, page 2, the 10 to 2,000 limits, the drivers' envelope, plate kinds | Totals, F10 |
| S8 errors | Unknown plate, unknown route, missing parameter | `not_visible`, `not_found`, `rejected` |
| S9 vehicle reads | The AXI's read routes on two sample vehicles | The command set |
| S9b deep reads (`--deep`) | Trip safety, heat map, events report, diagnostics history, event drill-down, BI drivers, safety per vehicle | `report`, `safety`, `diagnostics` |
| S10 transport | Latency, statuses, compression, limit headers, large integers, Hebrew text, date forms | 481, 474, 429; F2 |
| S11 AXI smoke | The built `ituran-axi` with this run's token: exit codes, TOON, the 4,000-character bound | The shipped binary |
| S12 parity (`--parity`) | `ituran-mcp@4.2.0` read-only agrees with the direct reads | The conversion |
| S13 Gate rules | Every route the run made, judged by `comis/key-services/ituran.json` | C3, R2, R5 |

**Safety rules, built into the code:**
- **Reads only.** The one HTTP helper sends GET, POST only to Ituran's read routes, and the token grant. Anything else is refused before it leaves the process.
- **Few sign-ins.** At most three requests to the token route per run: the account's grant, an unknown-user grant and its form-encoded twin, plus one refresh. `--parity` adds `ituran-mcp`'s one grant. S11 hands the AXI the run's token, so the AXI does not sign in.
- **Paced.** One request at a time, starts at least 400 ms apart.
- **Nothing secret stored.** The password and tokens are never printed or stored. Plates are scrubbed from every string.
- **No personal data in the report.** It records statuses, timings, counts, field names and value shapes, never values. It is written with mode 0600.
- **Probes that cannot lock the account.** Failure probes use a username that cannot exist and plate `0000000`.

```sh
cp test/live/.env.example test/live/.env.prod                                   # fill in; gitignored
node --env-file=test/live/.env.prod test/live/ituran-live.mjs                   # daily while building
node --env-file=test/live/.env.prod test/live/ituran-live.mjs --deep --parity   # weekly, and before a release
node --env-file=test/live/.env.prod test/live/ituran-live.mjs --strict --deep --parity  # milestone gate
```

**Exit codes:**
- 0: no failures. Blocked stages are allowed.
- 1: any failure, or any blocked stage with `--strict`.
- 2: usage error.

### 7.2 Keeping the fake honest

The live test's facts are the fake's specification:
- the error bodies and codes
- the 400 for a missing header
- the paging envelopes, including the drivers' top-level block
- the minutes `expires_in`
- the date forms

Contract tests check the fake against these values. The live test checks that production still matches them. When Ituran changes, S2, S3, S7 or S8 fails first, and the fake is updated in the same change.

## 8. What is not in this plan

These belong to the master plan:
- Comis changes C1 to C8
- Writes (phase 3) and composite commands (phase 4)
- Questions Q1 to Q8 for Ituran and the owner
