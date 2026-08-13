---
name: already-moved-idempotency-needs-provenance
description: "FIXED via entityMoves receipt — reassign 'alreadyMoved' must gate on positive provenance, never on 'entity is under toUserId' alone. Keep as the review pattern for any retry/heal branch."
metadata:
  type: project
---

**Status: FIXED** (2026-08-13, same review cycle) by an `entityMoves` receipt collection written
BEFORE the atomic flip; `resolveAlreadyMoved` now requires the receipt or returns 404. Kept because
the *pattern* recurs, not the bug.

Cross-account reassign gained an idempotent-retry branch (`resolveAlreadyMoved`) that concluded
"the move already happened" purely from *the entity is not under fromUserId but IS under toUserId*.
That predicate is satisfied by an entity `toUserId` has **always** owned and `fromUserId` never
touched, so a caller who never owned the row gets `200 { alreadyMoved: true }` plus two synthesized
op-log legs (a `delete` on the caller's log, a `create` re-publishing the victim's snapshot).

**Why:** the move is atomic (`replaceOne({_id, user: fromUserId})`), so after a successful flip
there is genuinely no server-side trace distinguishing the two cases. Idempotency was inferred
rather than recorded.

**How to apply:** any "did this already happen?" branch on a destructive cross-tenant operation
needs *positive provenance* — a receipt row, an op-log leg under `fromUserId`, or a caller-supplied
idempotency key — not just the post-state shape. When reviewing similar retry/heal branches, ask:
"what OTHER state also satisfies this predicate?" The `/v1` two-token consent gate narrows but does
not close it: the recipient token proves `toUserId` consented to *receive*, never that `fromUserId`
ever held the row.

Two design points worth reusing when a receipt is the answer:
- Write the receipt as a **claim of intent, before** the mutation. A stale receipt from a crash
  before the flip is harmless (the entity is still under `fromUserId`, so a retry takes the normal
  path); a receipt written *after* would be missing in exactly the crash window the heal exists for.
- Gate-neutralization probe: comment out the receipt lookup and re-run the tenant-isolation test.
  It must fail. A provenance gate that passes with the lookup removed is decorative.

Related: [[project_replaceById_tenant_bypass]], [[feedback_tenant_isolation_test_gap]].
