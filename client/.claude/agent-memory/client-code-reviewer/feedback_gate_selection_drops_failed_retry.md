---
name: gate-selection-drops-failed-retry
description: Narrowing the stop hook's e2e selection to "specs edited this turn" means a spec that failed is never rerun once the fix lands in app code; the gate reports green. Check retry paths whenever a check's input set shrinks.
metadata:
  type: feedback
---

When a check's selection moves from "everything in the uncommitted diff" to "only what was touched this
turn" (scripts/post-change-checks.sh e2e block, 2026-10-24), the follow-up turn that fixes a failure by
editing client source (not the spec) skips the failing spec and prints "✅ E2E checks passed".

**Why:** the sentinel is consumed before checks run, so nothing remembers what failed last time. The old
diff-based selection re-ran it for free.

**How to apply:** for any hook or gate change that shrinks its input set or adds a time budget, trace the
fail → fix-elsewhere → rerun path. The usual fix is to persist the failed set (or the timed-out set) and union
it into the next selection until it goes green. Related: [[verify-reviewer-claims-by-instrumenting]].
