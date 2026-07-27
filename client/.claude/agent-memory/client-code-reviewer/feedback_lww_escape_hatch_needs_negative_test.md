---
name: lww-escape-hatch-needs-negative-test
description: Escape hatches added to the LWW gate (poisoned-watermark self-heal etc.) need a paired negative test pinning the tolerance, plus a check that pending queued ops aren't discarded.
metadata:
  type: feedback
---

When a disjunct is added to the sync LWW gate in `applyEntityOp`
(`!existing || existing.updatedTs <= incoming.updatedTs || <newEscape>`), require **two** tests,
not one: the positive (escape fires and repairs) AND the negative (ordinary case still loses
LWW, so the escape can't fire spuriously). The negative is the one that gets skipped.

**Why:** Seen with the poisoned-watermark self-heal (server clamps future `updatedTs`, but its
correcting echo is by construction OLDER than the poisoned local row, so plain LWW can never
repair the device that created the poison). The escape necessarily *inverts* the normal
ordering rule, so its blast radius is bounded only by its tolerance constant — a too-tight
tolerance turns ordinary inter-device clock skew into silent data loss, and nothing else in the
suite would notice.

**How to apply:** For any new LWW disjunct, verify by mutation that removing the escape fails
the positive test AND that zeroing/removing the tolerance fails the negative one. Then check
three things the diff usually won't mention:
- **dayjs plugin dependency** — `isAfter`/`add`/`diff` are core; `isSameOrAfter`/`isBetween` are
  plugins that throw at runtime without an `extend()` call the node test env may not exercise.
- **Pending queued ops** — confirm the overwrite can't discard an unflushed local edit. Safe
  today only because `queueSyncOp` stores its own snapshot and flush reads `syncOperations`,
  never re-reading the entity row. If that ever changes, every LWW escape becomes data loss.
- **Synchronous predicate** — the check sits between the guarded read and the write inside one
  IDB transaction; an async predicate would auto-close the tx.

Related: [[feedback_concurrency_fix_untested_layer]] (mutation-test before approving),
[[feedback_inverse_pair_predicates]] (an asymmetric positive/negative pair like this one is
correct and is NOT the mirror-predicate smell).
