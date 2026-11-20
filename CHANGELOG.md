# Changelog

## 0.2.1 — 2026-11-20

- Make reads follow the caller's `COMIS_DEADLINE`, keeping the 25-second default when no deadline is supplied. Confirmed writes keep at most 55 seconds or the earlier caller deadline.

## 0.2.0 — 2026-11-19

- Add saved-place create, change and delete commands.
- Add account and per-vehicle alert create, change and delete commands, plus custom alert contact-channel changes.
- Add vehicle-group create, change, membership patch and delete commands.
- Preview the exact request by default or with `--dry-run`; send once only with `--confirm`. Writes never retry or follow redirects. Preserve new record IDs, Ituran error codes, and Comis approval wait instructions.
- Give confirmed writes a 55-second budget while respecting shorter task deadlines; uncertain outcomes and pending cards prohibit repetition and point to actions or account reads.
- Bound receipts to allowed result fields, report partial failures with exit 1, preserve non-plain DELETE 404 errors, and forget a refused cached token without replaying.
- Keep device commands, driver changes, drive sharing and contact writes unavailable. Prove the 14 allowed routes with fakes and the Comis catalog fixture. The owner's QA-account run remains pending.
