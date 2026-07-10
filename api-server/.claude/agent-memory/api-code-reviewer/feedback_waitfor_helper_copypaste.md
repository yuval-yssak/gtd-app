---
name: waitfor-helper-copypaste
description: The fire-and-forget-poll `waitFor(predicate, timeoutMs)` helper is copy-pasted verbatim into 4+ test files (itemDeleteGCalCascade, reassign, sync, routineDeleteItemCascade) instead of living in tests/helpers.ts.
metadata:
  type: feedback
---

Every test that asserts on a fire-and-forget GCal-pushback / cascade effect re-declares its own identical `waitFor(predicate, timeoutMs = 1000)` (deadline loop + 10ms sleep + throw "predicate never became true").

**Why:** GCal pushback (including the routine-delete item cascade in `pushRoutineDeletion`) runs fire-and-forget after the route already returned 200. Tests must poll the DB for the effect to land rather than race the assertion. So the pattern is correct and necessary — the problem is only that it isn't shared.

**How to apply:** When a new test file adds its own `waitFor`, note it as a non-blocking Abstraction suggestion (CLAUDE.md "Abstraction" — repeated pattern 2+ times → named abstraction) recommending extraction into `tests/helpers.ts`. Do NOT block on it: the copy-paste is a pre-existing convention, and each occurrence is self-contained and correct. Related positive-proof concern: [[project_sync_purge_test_timing_traps]] (prefer canary + waitForPurge over bare tick()).
