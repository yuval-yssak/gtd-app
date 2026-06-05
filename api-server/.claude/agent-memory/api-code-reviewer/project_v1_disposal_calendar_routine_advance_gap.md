---
name: v1-disposal-calendar-routine-advance-gap
description: /v1 complete & trash handlers advance nextAction routines only; calendar-routine skipped-exception recording is silently dropped server-side — comments tend to overclaim clarifyToTrash/clarifyToDone parity.
metadata:
  type: project
---

`POST /v1/items/:id/complete` and `POST /v1/items/:id/trash` both call
`maybeAdvanceRoutineForItem` → `advanceRoutineAfterDisposal`, which hard-returns
for any `routineType !== 'nextAction'` (`routineItemGeneration.ts`). The client's
`clarifyToTrash`/`clarifyToDone` → `maybeCreateNextRoutineItem` ALSO handles the
**calendar** branch: a before-due trash records a `skipped` routineException and may
deactivate an exhausted series (`client/src/db/itemMutations.ts` createNextCalendarRoutineItem).

So a headless/MCP caller trashing a future calendar-routine instance gets NO server-side
skipped-exception → the horizon generator can regenerate that instance. This is
out-of-scope **by design** (module comment in routineItemGeneration.ts), but handler
doc-comments repeatedly claim full `clarifyToTrash`/`clarifyToDone` parity, which is
false for the calendar branch.

**Why:** calendar routines use horizon-based generation (reads full items collection),
deliberately excluded from the nextAction generator.

**How to apply:** On any new /v1 disposal/advancement handler or comment, (1) reject
"mirrors clarifyTo* exactly" wording unless the calendar branch is actually handled;
(2) demand a test for a calendar-routine-linked item if the handler claims routine
advancement; (3) the gap itself is acceptable to inherit — push on the doc accuracy,
not on implementing calendar advancement. Related: [[project_cascade_emitted_ops_traverse_full_pipeline]].
