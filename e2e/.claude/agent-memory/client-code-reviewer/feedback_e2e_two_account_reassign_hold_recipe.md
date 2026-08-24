---
name: e2e-two-account-reassign-hold-recipe
description: Holding /sync/reassign in flight from Playwright needs four non-obvious things (pre-pull, SW block, POST-only route, direct IDB read) — none discoverable from the code
metadata:
  type: reference
---

Testing any UI branch gated on `usePendingReassign().isPending(...)` means holding a real
`POST /sync/reassign` open. Four infra facts, each of which costs a debugging cycle to rediscover:

1. **Pre-pull before mutating.** `withTwoAccountsOnOneDevice` leaves the server reset to the caller.
   Collecting before bootstrap completes strands the op in the queue and the next reload lands in
   the blocking "Full sync required" recovery dialog. Call `gtd.pull(page)` first.
2. **The service worker bypasses `page.route`.** Interception silently does nothing until the
   context is created with `{ serviceWorkers: 'block' }` — `withTwoAccountsOnOneDevice` takes an
   optional `contextOptions` param for this.
3. **Hold only the POST.** Trapping the CORS preflight OPTIONS wedges the page's fetch outright
   rather than leaving it pending, so the in-flight UI state never renders.
4. **Read IDB directly for the post-move assertion.** `gtd.listItems` is active-account-scoped and
   the reassigned row now belongs to the *other* account; use
   `page.evaluate(... __gtd.db.get('items', id))`. Also do NOT add an explicit `gtd.pull` after
   releasing — a concurrent orchestrated pull pivots the active Better Auth session mid-post-flight
   and the reassign's own pull fails its session-match guard.

**How to apply:** cite this whenever a review asks for coverage of a reassign-blocked branch, so the
author doesn't conclude "this is untestable" and ship the branch bare. Canonical implementation:
the "mid-reassign item gets a working escape hatch" test in `e2e/weekly-review.spec.ts`. Related:
[[inflight-escape-hatch-semantics-mismatch]], [[e2e-goto-mid-flush-lock]].
