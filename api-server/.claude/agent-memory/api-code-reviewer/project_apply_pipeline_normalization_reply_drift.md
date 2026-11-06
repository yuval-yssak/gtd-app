---
name: apply-pipeline-normalization-reply-drift
description: When toServerOperation normalizes a snapshot (e.g. routine exception prune), /v1 routes and composites that reply with their pre-apply snapshot echo a row that differs from the stored one
metadata:
  type: project
---

Any snapshot transform added inside the apply pipeline (`toServerOperation`) silently diverges from callers that build a snapshot, apply it, then `return c.json(present(snapshot))` or hand it to follow-up logic (`propagateRoutineEditToItems`, `ensureFirstRoutineItem`). First seen 2026-11-06: 1aca4a5 pruned past-series-end routineExceptions in the pipeline; PATCH /v1/routines and `updateRoutine` (pause/resume) kept replying with the untrimmed list until fixed by pre-trimming.

**Why:** the apply functions return void/op, not the stored row, so routes reuse their own input.

**How to apply:** when a review adds or changes a normalization in the apply pipeline, enumerate every caller that replies with or reuses its own snapshot (PATCH, composites, split head/tail, batch `updatedTs`), and check each produces the same shape. Batch only echoes `op.snapshot.updatedTs`, so it is immune; split's capped head self-filters equivalently.
