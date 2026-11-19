# Changelog

## 0.2.0 — 2026-11-19

- Add saved-place create, change and delete commands.
- Add account and per-vehicle alert create, change and delete commands, plus custom alert contact-channel changes.
- Add vehicle-group create, change, membership patch and delete commands.
- Preview the exact request by default or with `--dry-run`; send once only with `--confirm`. Writes never retry or follow redirects. Preserve new record IDs, Ituran error codes, and Comis approval wait instructions.
- Keep device commands, driver changes, drive sharing and contact writes unavailable. Prove the 14 allowed routes with fakes and the Comis catalog fixture. The owner's QA-account run remains pending.
