# ituran-axi recipes

Rows are the indented lines of a TOON table. The help hints at the end are
indented too, but each starts with `- `, so `grep '^  [^-]'` keeps only the rows
and `sort -t,` sorts them. Use `--fields` to choose simple columns first. A pipeline
needs every row: add `--full` (default output stops at about 4,000 characters)
and a `--limit` that covers the total in the summary line. Reports and safety
grades take at most 1,000 rows a page.

Run commands in sequence. Commands for the same host user take a process lock, with a 400 ms gap between commands. The lock directory defaults to `/tmp/ituran-axi-<uid>`, independent of per-command temporary and cache directories. Wrappers with private filesystem namespaces must set `ITURAN_AXI_LOCK_DIR` to one writable directory shared by every command. If the selected directory is unavailable, reads continue without process locking. Separate users or hosts need external coordination. Abandoned locks recover automatically. A concurrent command waits within its 25-second overall budget (less when `COMIS_DEADLINE` is earlier), then returns `busy` if the lock is still held. Other timeouts return `unreachable`; ask for a shorter window before trying again. `trips`, including `--by plate`, accepts at most 56 days; `--limit` only limits output rows.

**Vehicles not seen for two days**
```sh
ituran-axi where --stale 48h --limit 2000
```

**Vehicles within 5 km of a point, nearest first**
```sh
ituran-axi where --near 32.08,34.78 --within 5
```

**Battery, fuel or charge readings for every vehicle** (each with its own age)
```sh
ituran-axi diagnostics --all --limit 2000 --full | grep '^  [^-]' | grep -i 'voltage'
```

**Vehicles driving now**
```sh
ituran-axi where --all --fields plate,status,speed --limit 2000 --full | grep '^  [^-]' | grep ',driving,'
```

**Vehicles in a saved place now**
```sh
ituran-axi places <name>            # its id
ituran-axi place <id> --vehicles
```

**Vehicles in no saved place now**
```sh
ituran-axi vehicles --fields plate,places,age --limit 2000 --full | grep '^  [^-]' | grep ',null,'
```

**Distance per vehicle yesterday, most first** (columns: date, plate, distance, ...)
```sh
ituran-axi report daily --date <YYYY-MM-DD> --limit 1000 --full | grep '^  [^-]' | sort -t, -k3 -nr | head
```

**Each vehicle's trips, km, km a day and top speed over the last 30 days** (one row per vehicle, the vehicles that did not drive included; columns: plate, trips, km, km_per_day, max_speed)
```sh
ituran-axi trips --since 30d --by plate --limit 2000 --full
```

**One table: odometer, km a day and top speed for every vehicle** (join on the plate)
```sh
ituran-axi odometer --all --limit 2000 --full | grep '^  [^-]' | sort > odometer.csv
ituran-axi trips --since 30d --by plate --fields plate,km_per_day,max_speed --limit 2000 --full | grep '^  [^-]' | sort > month.csv
join -t, odometer.csv month.csv
```

**Fastest trips in the last day** (columns: plate, max_speed, driver)
```sh
ituran-axi trips --since 24h --fields plate,max_speed,driver --limit 2000 --full | grep '^  [^-]' | sort -t, -k2 -nr | head
```

**Lowest safety grades this week** (columns: plate, driver, safety, fuel)
```sh
ituran-axi safety vehicles --since 7d --limit 1000 --full | grep '^  [^-]' | sort -t, -k3 -n | head
```

**Engine on and off for one vehicle yesterday**
```sh
ituran-axi report engine <plate> --date <YYYY-MM-DD> --limit 200
```

**Which vehicles are idling now**
```sh
ituran-axi events                    # the idling state's id
ituran-axi event <id>
```


**Exact position age with driver and group references** (page if the summary has more)
```sh
ituran-axi where --all --fields plate,time,age,age_seconds,driver_id,group_ids --limit 2000 --full
```
`age` retains its rounded wall-clock display; `age_seconds` measures elapsed
seconds using the account zone at the position time, including DST changes.
Repeated fall-back times and nonexistent spring-forward times return `null`.
Keep the timestamp and zone when comparing reads.

**Mileage for a vehicle group yesterday**
```sh
ituran-axi groups --vehicles --full
ituran-axi groups <id> --full
ituran-axi report periodic --group <id> --date <YYYY-MM-DD> --limit 1000 --full
```
Read `group_km` for the total across every matching BI row, even if the displayed
rows need another page. Member plates are deduplicated. The group uses the plates
Ituran currently lists for it; child-group lists are not merged. Whether a parent already includes descendants is unverified until a
live run, and these reads cannot recover historical membership. Do not
sum overlapping groups as a fleet total. A `partial` field or `group_km: null`
means the group mileage could not be completed. Check `group_unreported_vehicles`;
a missing BI row is not evidence of zero mileage. BI row coverage for stationary
vehicles and distance availability in idle rows remain unverified until a live run.

**Dated records at a saved place**
```sh
ituran-axi places <name> --refresh
ituran-axi report events <plate> --place <id> --date <YYYY-MM-DD> --limit 2000 --full
```
Name lookup reads the complete saved-place index, including places beyond the
first listing page. An unfiltered `places --limit 200` is a page, not the entire
catalog; follow the next-page hint. Place events are dated evidence of presence,
not complete visits or exact arrival/departure intervals. Reports require explicit
plates; repeat for the vehicles of interest. If more records exist at the maximum
limit, narrow the time window.

**Historical events and speeding**
```sh
ituran-axi report events <plate> --since 24h --limit 200
ituran-axi report speed <plate> --over 100 --since 24h --limit 200
```
`events --all` includes empty current event states; it does not request history.
Future window ends are clipped to the safe current cutoff (two minutes ago).

**Maintenance targets and complete diagnostic readings**
```sh
ituran-axi maintenance <plate> --limit 2000 --full
ituran-axi diagnostics --all --limit 2000 --page 1 --full
ituran-axi diagnostics --all --limit 2000 --page 2 --full
```
Maintenance includes `next.date`, `next.odometer` and `next.engine_hours` when
the API sends them. `without_due_target` records cannot be classified as overdue. Check schedule and
meter consistency before classifying service needs. Diagnostic summaries count
all fetched readings, while the table is one page. Follow its next-page hint and
check each reading's age. Pages re-read current data and can shift between calls.
An old sample is not a current health assessment.

## Create, change or remove a saved place

Preview the complete request before sending it. These examples use neutral test records. Writes have been tested on fakes only; the owner performs the QA-account run.

```sh
ituran-axi place add --body '{"name":"Depot A","place_type":"Circle","point":{"latitude":32.1,"longitude":34.8},"radius":150}' --dry-run
```

Run the same command with `--confirm` instead of `--dry-run` to send it once. Its response gives the new `place_id`. Use that ID to edit or remove it:

```sh
ituran-axi place edit 101 --body '{"name":"Depot B","place_type":"Circle","point":{"latitude":32.1,"longitude":34.8},"radius":200}' --dry-run
ituran-axi place remove 101 --dry-run
```

A change sends every field in the body, without reading or merging the old record. A delete sends no body. You can also keep the complete body in a local file and give `--body @request.json`.

## Set an alert for existing contacts

Find the account's alerts with `ituran-axi alerts`; alert recipients must already be contacts in Ituran. The CLI cannot create or change contacts.

```sh
ituran-axi alert add --body '{"alert_name":"Night use","event_type":"Ignition","alert_contacts":[7,8],"license_plates":["10000001"],"vehicle_group_ids":[301]}' --dry-run
ituran-axi alert edit 201 --body @alert.json --dry-run
ituran-axi alert custom 201 --body '{"contact_id":7,"is_send_push":true,"is_send_sms":false,"is_send_email":false}' --dry-run
ituran-axi alert remove 201 --dry-run
```

For an alert attached to one vehicle, give its plate on add, edit or remove:

```sh
ituran-axi alert add --plate 10000001 --body @alert.json --dry-run
ituran-axi alert edit 201 --plate 10000001 --body '{"speed_exceeds":90}' --dry-run
ituran-axi alert remove 201 --plate 10000001 --dry-run
```

## Change a vehicle group and its members

Read `ituran-axi groups` for IDs and `ituran-axi groups 301` for the current listed plates. A membership change affects the group; it sends no command to a vehicle.

```sh
ituran-axi group add --body '{"vehicle_group_name":"North","icon_id":2,"parent_group_id":1,"license_plates":["10000001"]}' --dry-run
ituran-axi group edit 301 --body '{"vehicle_group_name":"North depot","icon_id":2,"parent_group_id":1,"license_plates":["10000001"]}' --dry-run
ituran-axi group members 301 --body '{"license_plates":{"add":["10000002"],"remove":["10000001"]}}' --dry-run
ituran-axi group remove 301 --dry-run
```

Replace `--dry-run` with `--confirm` only after checking the request. In Comis each write still waits for the owner's card. When output says `held_for_approval`, run the printed `comis action wait <id>` command; do not resend the write. Declined or expired writes are refused. Earlier Comis connections stay read-only until the owner disconnects and reconnects Ituran.

Writes never retry automatically. Repeating an edit, membership patch or delete requests the same final state; a delete of an absent record returns `already_absent: true`. A repeated `add` can create another record. If a confirmed write times out, check Ituran before trying again. Device commands, driver changes, drive sharing and contact writes are never available and have no approval path.
