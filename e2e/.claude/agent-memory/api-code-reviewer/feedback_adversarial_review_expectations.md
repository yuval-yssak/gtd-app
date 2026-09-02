---
name: review-adversarial-op-loss-tracing
description: This team wants adversarial reviews that hunt concrete failure scenarios; they act on every blocking finding and push back with reasoning when they disagree
metadata:
  type: feedback
---

When asked for an adversarial review, produce concrete **failure scenarios** (specific interleavings
/ sequences that break the code), not severity labels. Each finding needs a reproducible narrative
and a code-level fix.

**Why:** on the sync op-identity change-set, five blocking findings were all fixed faithfully in one
pass, including two the author had to reason about independently. Findings framed as scenarios got
acted on; the value came from tracing interactions *between* the change and existing consumers
(client forward-only cursor guard, purge floor, retry route) rather than from reviewing the diff in
isolation.

**How to apply:**
- Grep for every consumer of a changed invariant before concluding it is safe. The worst bug in that
  review (`/sync/issues/retry`) was in a file the diff never touched.
- Verify ordering/overflow claims by actually running the comparison (e.g. `node -e` on lexicographic
  string sorts) instead of reasoning about them — the seq-overflow break was counterintuitive.
- Expect informed pushback: the coordinator disagreed with one scenario ("permanent stall" —
  argued it self-heals as the holdback tracks wall clock) while still implementing the clamp because
  it was correct regardless. Disagreement with reasoning is normal here, not resistance.
- They report full check status (lint/typecheck/test counts across api/client/e2e) unprompted, so
  trust-but-spot-check rather than re-running everything.

Related: [[op-cursor-ordering-invariants]]
