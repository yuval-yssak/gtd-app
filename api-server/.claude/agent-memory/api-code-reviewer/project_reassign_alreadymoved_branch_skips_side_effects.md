---
name: reassign-alreadymoved-branch-skips-side-effects
description: Side effects bolted onto reassignItem/reassignRoutine after the owner flip are silently skipped on the alreadyMoved crash-heal branch — check both exits
metadata:
  type: project
---

`lib/reassignEntity.ts` has three exits per entity arm: the happy flip, the
up-front "not under fromUserId" miss, and the post-flip `not-owned` race — the
latter two both funnel into `resolveAlreadyMoved`, which only re-emits op-log legs
via `republishOwnerMoveOps`. Any new side effect appended after
`applyAndPublishOwnerMove` (e.g. `cascadeItemBriefRemoval`) runs on the happy path
ONLY, so the crash-heal retry that `resolveAlreadyMoved` exists to serve never
performs it.

**Why:** `applyAndPublishOwnerMove` deliberately bypasses
`runReferenceCascades` (it calls `notifyChange` directly, not
`applyAndPublishOperation`), so per-move cleanup has to be hand-called in the arm —
and the author naturally writes it at the one site that reads like "the move
succeeded". The comment "idempotent, so a retry is safe" is the tell: idempotent
code that the retry path never reaches.

**How to apply:** when a diff adds work after the owner flip in `reassignItem` /
`reassignRoutine`, check whether `resolveAlreadyMoved` also needs it. Ask for the
call to move inside `resolveAlreadyMoved` (or to be run before the branch), and
for a test that crashes/retries into the `alreadyMoved` branch.
