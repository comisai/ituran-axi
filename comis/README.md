# Comis connector bundle

This folder holds everything the Comis repository needs to connect Ituran through `ituran-axi`. It lives here, tested against the real AXI, until `ituran-axi` is published to npm (master plan M5). The Comis changes cannot land before that: a pack installs AXIs only from its npm lock, with provenance checked (D335).

| File | Comis change | Goes to, in the Comis repository |
| --- | --- | --- |
| `key-services/ituran.json` | C3: the catalog entry | `catalog/key-services.json`, key `ituran` |
| `skills/ituran/SKILL.md`, `recipes.md` | C4: the read skill (`main reader`) | `images/packs/apps/skills/ituran/` |
| `bin/ituran-axi` | C5: the pack wrapper | `images/packs/apps/bin/ituran-axi` |
| `decisions.md` | C1 and C2: the drafts behind D3630 and D3617 | `docs/decisions/` (in PRs #3630 and #3617) |

## What is proven here

`test/contract/comis-bundle.test.ts` checks the bundle against the AXI itself.

**Routes:**
- Every command runs against the fake Ituran in token mode, as inside Comis.
- Each request it sends matches the credential's `match` list, so the Gate injects the token.
- Each request passes as a read: a GET, or a POST listed in `reads`.
- Token mode never calls the token route.

**Refusals:** these all resolve to `deny`:
- the token route
- device commands and share-drive
- writes to places, alerts, vehicle groups and contacts
- password and user-setting routes
- the broken push-alert search

Contacts, drive-permission groups and the swagger pages never get the token.

**Skill and wrapper:**
- The skill uses flat string metadata and names only commands that exist.
- The wrapper turns on `NODE_USE_ENV_PROXY`, fixes `ITURAN_URL`, and runs the published bin path.

The matcher follows the Gate's rules as `priority-axi` recorded them:
- paths only
- `{name}` matches `[A-Za-z0-9._~-]+`
- `{a|b}` matches one listed literal
- `{name...}` matches the remaining segments

The Comis proofs (design §13) must still run the real Gate.

## Landing it in Comis

Merged into Comis `main` on 2026-11-08:
- [PR #3617](https://github.com/comisai/comis/pull/3617): the proposal (`docs/research/Ituran Connector Proposal for Comis v2.md`) and C2, decision D3617.
- [PR #3630](https://github.com/comisai/comis/pull/3630), stacked on #3617: C1, decision D3630, and C3, the catalog entry.

1. **C1: the Gate password exchange** (D3630, PR #3630). The credential names `"exchange": "ituran"` beside `"secret": "ituran"`. If Ituran issues a static key instead (master plan Q1), drop the `exchange` field.
2. **C2: keep Ituran's 403** (D3617, PR #3617). Its first version raised on a 403 with no challenge header, which is what Ituran sends; the PR's no-challenge test caught it.
3. **C5: the pack and the provenance check.** This is shared with `priority-axi`.
   - Add `"ituran-axi": "<version>"` to `images/packs/apps/package.json` and refresh its lock.
   - Add the source repository to `scripts/axi-publishers.json`.
   - Copy the wrapper, and add `ituran-axi` to `doctor/probe` and `NOTICE`.
4. **C3: the catalog entry** (PR #3630). `key-services/ituran.json` mirrors it, and `test/contract/comis-bundle.test.ts` checks the mirror. The key page labels its two fields Username and Password.
5. **C4: the skill.** Copy `skills/ituran/`.
6. **C6: proofs.** Add a fake Ituran to `tests/integration/connectors/`, using `test/fake/ituran-fake.ts` as the reference for its answers. Then run:
   - `ituran-reads`
   - `ituran-token-custody`
   - `ituran-reconnect-needed`
   - `ituran-placeholder-host`
   - `ituran-refusals`
   - `ituran-record-source-binding`
7. **C7: documentation.** Add `docs/ituran.md`: what to ask Ituran for (master plan §7), the commands, and the refusals.
