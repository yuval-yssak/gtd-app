---
name: spec-header-comment-outlives-inline-edits
description: e2e spec file-header block comments describing the whole flow go stale when a step is removed; the inline comment at the edit site gets updated, the header does not
metadata:
  type: feedback
---

`e2e/*.spec.ts` files open with a multi-line block comment summarizing the whole flow under test.
When a step is removed from the flow, the inline comment at the edit site gets rewritten but the
file-header summary keeps describing the removed step.

**Why:** the system-inbox-row removal updated the inline "Stage 1 — checklist: ..." comment at
weekly-review.spec.ts:23 but left line 6's header still reading `inbox checklist (system + seeded
user-defined buckets)`. It also evaded a `grep -i "system inbox"` sweep because the header phrases it
as `system +`, not `system inbox` — the exact term only appears in the deleted code.

**How to apply:** whenever a diff removes a step/stage/affordance from an e2e flow, read the top ~10
lines of every touched spec, don't just grep. Grep for the *concept* in several phrasings, and treat
the file-header block as a required review target alongside the changed test bodies. Same failure
mode as [[feedback_affordance_relocation_leaves_third_copy]], where "we deliberately do not render X
here" comments strand in unchanged hosts.
