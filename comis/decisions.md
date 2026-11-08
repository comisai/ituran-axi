# Drafts for two Comis decision records

Both change the Gate, a high-risk area under AGENTS.md §6. Each needs its own decision record, threat note and failure-mode tests before any code. This file is input for those records. It is not a decision.

**Where they went (2026-11-08).** Both are now decision records in Comis pull requests, and those records are authoritative:
- C1 became [D3630](https://github.com/comisai/comis/pull/3630). It is built as a closed `EXCHANGES` table and a credential field, `exchange: ituran`, beside a stored `secret`, not as a new OAuth provider as drafted below. That keeps the key page's two-part key and needs no CLI or Hub flow.
- C2 became [D3617](https://github.com/comisai/comis/pull/3617), as drafted. Any challenge header is dropped, and a 403 without one, as Ituran sends, passes through the rest of response custody.

## C1: a password-grant connection for Ituran

**Need.** Ituran's API takes a bearer token that lives 24 hours. The only way to get one is the identity route's password grant, `POST https://api.ituran.com/api/v1/oauth/token`.
- The grant takes a JSON or form body: `{grant_type: "password", username, password, device_id, culture}`.
- It returns `{access_token, token_type: "bearer", expires_in: 1440, refresh_token}`. `expires_in` counts minutes.
- A refresh grant rotates both tokens. The old access token keeps working.

The workbench must not hold the password or a token (spec §6.4), and Comis has no static key for this service. Ituran's access protection also blocks addresses that sign in again and again (HTTP 474), so the connection must sign in rarely.

**Proposal.**
- **A new provider.** The Gate's closed provider table gains `ituran`, beside the code and device grants. It has:
  - `token`: the URL above
  - `grant`: `password`
  - `parameters`: `{device_id: "comis-gate", culture: "en-US"}`
  - `expires_unit`: `minutes`
  - `confidential: false`
- **Connecting.** `comis connect ituran` opens the existing single-use key page with two fields, username and password, as Trello's key and token do. The Gate keeps the password encrypted with its other secrets and makes the first grant at once. A 400 or 401 refuses the connection with a fixed sentence and never quotes Ituran's body.
- **Refreshing.** One refresh at a time, five minutes before the end, storing the rotated refresh token atomically, as for Google and Microsoft. When a refresh fails, the Gate tries one password grant. When that fails too, the owner gets "reconnect needed".
- **Injecting.** The workbench gets a stable placeholder in `ITURAN_TOKEN`. The Gate swaps in the current token on requests that match the entry's `credential.match`.
- **Refusing.** `* /api/v1/oauth/{path...}` is denied to every workbench, so no client in the sandbox signs in.

**Failure-mode tests:**
- The password grant is refused (401), and the connection is refused with no body quoted.
- A two-step account answers 2xx with no `access_token`. The connection is refused with "use a service account without two-step sign-in".
- 474 from the access protection: no retry storm. One notice to the owner.
- The refresh token has expired. One password grant follows; if it fails, "reconnect needed".
- The Gate restarts between a refresh's answer and its write. The next start finds the old refresh token rejected, makes one password grant, and keeps one connection.
- A placeholder is sent to the token route. It is refused and reported as a leak.
- A workbench posts its own grant with a guessed password. It is denied before any upstream connection.
- The stored password appears in an outgoing body. It is refused as `real-secret`.

**Line cost.** One provider entry, a password-grant branch beside the code and device grants, the minutes unit, and the key page's second field. No new route. No new storage: tokens use the existing OAuth store.

**Alternative.** If Ituran issues a long-lived API key (master plan Q1), the entry uses `"secret": "ituran"` with `inject: bearer` and C1 is not needed.

## C2: Ituran's 403 is not "reconnect needed"

**Need.** The Gate turns a credentialed host's 401 or 403 into 502 "reconnect needed" (`proxy.py`). Ituran uses 403 for answers that have nothing to do with the credential:
- `1020`: the plate is not in this account
- `1006`, or an empty body: the account lacks a service
- `403.2`: a feature is off

Measured live on 2026-11-08. With today's rule, asking about a mistyped plate would tell the owner to reconnect Ituran.

**Proposal.**
- **A per-service flag.** `"forbidden_is_entitlement": true` on the service. A 403 from that service passes through with its JSON body, bounded as other bodies are, while 401 keeps becoming 502 "reconnect needed".
- **Precedent.** OpenRouter's content-policy refusals keep their 403 (D360, D361).

**Failure-mode tests:**
- 403 `1020`, `1006` and `403.2` reach the workbench with their bodies, and the owner gets no reconnect notice.
- 401 still becomes 502 "reconnect needed" and notifies the owner once.
- A 403 whose body carries the stored token or password is withheld, as any response is.
- The flag on one service does not change another credentialed service's 403.
