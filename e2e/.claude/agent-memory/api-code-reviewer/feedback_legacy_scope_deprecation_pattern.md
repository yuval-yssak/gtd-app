---
name: Legacy scope deprecation pattern (in-memory bridge, no DB rewrite)
description: When deprecating an ApiTokenScope, the team's chosen pattern is keep-in-union + exclude-from-mint + in-memory backfill. Stored rows are never rewritten so audit/revocation against the original scope still works.
type: feedback
---

When deprecating an `ApiTokenScope` value (e.g. `items.clarify` → `items.write` in Phase 2), the team's chosen pattern is:

1. Keep the legacy value in the `ApiTokenScope` union so reads from Mongo still type-narrow cleanly.
2. Keep it in `VALID_API_TOKEN_SCOPES` (parsing allowlist) but exclude from `MINTABLE_API_TOKEN_SCOPES` (mint allowlist) so new tokens cannot receive it.
3. In `bearerMiddleware`, append the replacement scope to the in-memory request scope array when the legacy one is present — but never rewrite the stored row.
4. Mint endpoint surfaces a hint pointing at the replacement when the rejected scope is the legacy one.

**Why:** Rewriting the stored row would let `items.write` propagate silently to user-facing surfaces (settings UI scope chips, `presentToken` projection, etc.) and would lose audit fidelity — the team wants to be able to identify "this token predates Phase 2" by looking at the row, e.g. for a future `revoke-all-pre-phase2` operation. The in-memory bridge keeps the mint rule "no new items.clarify" trivially correct.

**How to apply:** when reviewing a future scope deprecation, expect to see all four pieces. If a PR rewrites the stored row in the bridge step (e.g. adds a `setScopes` call on the legacy detection path), flag it as a deviation — that path is reserved for the original scopes-undefined → DEFAULT backfill, which is one-time per row and idempotent. Flag also any test that asserts the stored row contains the *new* scope after a legacy-token request — the assertion should be that the legacy scope is preserved.
