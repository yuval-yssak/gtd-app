---
name: new-synced-entity-wedges-old-clients
description: Adding an EntityType server-side emits ops into /sync/pull that old client builds can't dispatch; client applyServerOp's throw halted the whole pull loop before advanceSyncCursor.
metadata:
  type: project
---

Adding a new synced `EntityType` on the server is never a server-only change: `/sync/pull`
immediately starts delivering ops of that type to EVERY device, including client builds that
predate it. The client's `applyServerOp` dispatch previously ended in a `throw` on the
`never` default branch, and its caller (`doPull`) awaits it in a bare loop that must complete
before `advanceSyncCursor` runs. So one unknown op permanently wedged sync for ALL entity
types on that device — re-fetch, re-throw, forever.

**Why:** caught during the `reviewInbox` review (2026-08-23). The server diff was flawless in
isolation; the defect only appeared by tracing the op across the client boundary. The
compile-time `never` check gave false confidence — the client's `EntityType` mirror had
already been widened, so the branch was reachable at runtime while still type-checking.

**How to apply:** when reviewing a new synced entity, always open
`client/src/db/syncHelpers.ts` and confirm (a) `applyServerOp` has the case arm, (b)
`EntityStoreName` includes the store, (c) the default branch SKIPS rather than throws.
Resolution kept the `never` assignment (so a known-at-build-time omission is still a compile
error) but replaced the throw with warn+return (so a genuinely-unknown future type degrades
safely). Verify both halves: delete the case arm and confirm typecheck still fails.
Related: [[project-sync-push-routine-schema-jam]], [[feedback-verify-tests-discriminate-by-stashing-source]].
