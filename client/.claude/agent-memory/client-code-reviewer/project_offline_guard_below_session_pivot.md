---
name: offline-guard-below-session-pivot
description: Offline checks placed inside API wrappers are dead code when the caller wraps them in withOwnerSession — the pivot itself is a network call that rejects first
metadata:
  type: project
---

Client API modules keep putting `isBrowserOffline()` inside the HTTP wrapper, but the
Weekly Review / calendar / assist call sites wrap those wrappers in `withOwnerSession`.
`withOwnerSession` → `withAccountSession` → `withSessionGate(async () => { await
loadDeviceSessionsByUserId() ... })`, and `loadDeviceSessionsByUserId` is
`authClient.multiSession.listDeviceSessions()` — **a network call**. Offline it rejects
before the wrapper's own guard is ever reached, so the wrapper's `skipped/offline` branch
is unreachable from production and only the unit test (which calls the wrapper directly)
exercises it.

**Why:** bit the `sweep-mine` review-start sweep (2026-09-21). A module-level once-per-run
guard claimed its key synchronously, then the pivot rejected offline, so the run was marked
"already swept" without a request ever being made — and by design there was no retry.
Offline review opens silently lost the feature for the whole run.

**How to apply:** when reviewing any effect/handler shaped
`withOwnerSession(id, someApiCall)`, check where the connectivity guard lives. It must sit
*above* the pivot (in the caller/guard layer), not inside the API module. Keep the API-module
guard only as defence-in-depth for direct callers. Same reasoning applies to any "claim a
key / set a flag before awaiting" idempotence guard: a pre-request failure must not consume
the claim.

Related: `withSessionGate` is a **global** serialization point for all sync pulls with a 10 s
escape hatch — advisory fire-and-forget calls should skip the pivot entirely when
`loggedInAccounts.length <= 1`, and any request timeout must stay below 10 s or it trips the
gate release while still holding a pivoted cookie. See [[cookie-idb-active-account-drift]].
