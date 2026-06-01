---
name: routine-item-generation-test-flake
description: src/tests/routineItemGeneration.test.ts is pre-existingly flaky (~1/8 runs) — fire-and-forget fan-out races the next test's beforeEach deleteMany, emptying the items collection.
metadata:
  type: project
---

`src/tests/routineItemGeneration.test.ts` fails intermittently (~1 run in 5-8) with a cascade of `expected [] to have a length of 1 but got +0` across unrelated describe blocks (bootstrap, complete, pause/resume). It is NOT caused by any single change — reproduced on clean `main` (no diff applied) at the same rate.

**Why:** the route handlers go through `applyAndPublishOperation`, whose Step 6 `notifyChange` GCal/webhook legs are fire-and-forget, plus the bearer middleware's fire-and-forget `lastUsedTs` bump. When one of these in-flight async writes lands AFTER the next test's `beforeEach` `db.collection('items').deleteMany({})`, it can leave the collection in an unexpected state for the now-running test, so item-count assertions see 0. Adding more request-heavy tests (e.g. the PATCH re-stamp block) raises the per-file probability but does not introduce the bug.

**How to apply:** Do NOT treat an intermittent red run of this file as a regression caused by the diff under review. Re-run 3-5x (or `git stash` + re-run) to separate signal from this latent flake. The real fix is test-infra (await/drain fire-and-forget tails before `beforeEach` wipe, or per-test DB isolation) — flag it as a suggestion, not a blocker, unless the diff itself adds a NEW awaited-but-unawaited path. Related LWW concern: [[project_snapshot_replace_defeats_lww_on_concurrent_edits]].
