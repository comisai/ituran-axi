# Round-two fleet-manager gaps

This change was checked against the existing client, fake, Gate fixture and the
supplied Ituran API snapshots. It makes no live calls and adds no upstream routes.
The snapshots are reference material, not a guarantee that every account returns
all fields. They are not copied into this public repository. The neutral
`test/fixtures/round2-api-shapes.json` models only the fields used by the tests.

| Case | Finding and change | Remaining limit |
| --- | --- | --- |
| I01 positions | Client gap: `LastLocation` has a timestamp, `Driver` supplies the current driver, and `additional_fields=VehicleGroup` supplies `vehicle_groups` on vehicle reads. Add `age_seconds`, `driver_id`, `groups` and `group_ids`; request the selected blocks in `where`. Keep existing default columns and rounded `age`. | Ages follow naive account-local wall time. Missing positions stay unknown; offset-free times cannot resolve an ambiguous daylight-saving hour. |
| I02 group mileage | Client gap: group reads support `additional_fields=license_plates`. Detail now requests membership; `groups --vehicles` shows it in the tree. BI `report --group` filters all fetched rows and sums their distances before displaying a page. | Membership is current and direct, not historical or inherited. No native group mileage route is established by the reference; totals are derived locally. Overlapping groups must not be added as a fleet total. Missing member report rows or distances leave `group_km` unknown; coverage counts distinguish that from an empty group. |
| I04 place history | Client gap: the existing events/full report POSTs support `place_ids` and return dated `places` identities. Add `--place` to those reports. | These are event records, not a guaranteed complete sequence of entry/exit intervals. An absence of records does not establish no visit. Explicit vehicle plates are still required by operational reports. |
| I04 partial place list | No paging defect reproduced: a 1,265-place fake verifies indexed lookup of the last place and page 7 of a 200-row listing. | The default table is bounded and a listing page remains a partial view. Use name search or follow the next-page hints; `--full` lifts size bounds, not row limits. |
| I05 maintenance | Client gap: treatment rows carry nested `next.date` and `next.odometer`, flattened already but omitted by the default column cut. Preserve the existing columns and append those targets. Count `without_due_target`. | The API can omit targets or return stale/inconsistent schedules; no due date is invented and no missing target is treated as overdue. Maintenance V1 has no standalone swagger. |
| I05 diagnostics | Client gap: reads walk vehicle pages, but the displayed readings had no way past the first `--limit`. Add `--page` and next-page hints. | Each channel is sampled at its own time and may be old or absent. Output completeness does not establish current fleet health. |
| R2-13 event history | Guidance gap: `events --all` correctly reads current state statistics. Add an unconditional hint to `report events`, including empty-state output and help text. | State statistics are not historical events. |
| R2-13 speed | The missing `--over` message already existed; validate it before reading the account and test the explicit hint. Help marks it required for speed reports. | The API needs a speed threshold. |
| I07 future range | Existing behavior retained and tested: future ends are clipped to the current safe cutoff. | Operational windows end two minutes before now. |
| R2-08 driver masking | No client defect established; this is the Comis output masker and remains outside this repository. | Comis owns its masking fix. |

Reference points: Global service `AdditionalFields`, `VehicleResponse`,
`VehicleGroups_AdditionalFields`, `VehicleGroupResponse`; Reports service
`EventsReportRequest`, `EventsReportResponse`, `FullReportRequest`,
`FullReportResponse`; the parameters dictionary's Maintenance/Treatments V1
`last` and `next` fields. The supplied Global snapshot uses v3 paths but documents
the operation-identical v2 service this client already uses.

All network changes are query/body fields on existing reads:

- GET `/api/v2/vehicles`, GET `/api/v2/vehicles/{plate}` and POST `/api/v2/vehicles/search`.
- GET `/api/v2/vehicle-groups` and GET `/api/v2/vehicle-groups/{id}`.
- POST `/api/v2/reports/events-report` and POST `/api/v2/reports/full-report`.
- Existing BI and Maintenance/Treatments reads retain their methods and routes.

There are no new methods/routes for the Comis Gate allowlist. A release would
need the Comis apps pack version updated and its `ituran-read` skill taught the
new fields, group reports, place filter and diagnostics paging. Those changes
belong in Comis after a release; this change does not publish a package.
