---
name: Public-API writable-fields drift between server-managed and user-facing fields
description: Recurring under-tested area — public-API write routes must allowlist user-facing entity fields and exclude server-maintained sync anchors, exception state, and split-history fields. Zod validates shape only, not "who may write".
type: project
---

When reviewing new `/v1/*` write surfaces, the route-layer `WRITABLE_FIELDS` (or `PATCH_ALLOWED_FIELDS`) allowlist is the ONLY gate that stops public-API callers from clobbering server-managed entity state. Zod schemas validate shape, not authority. Phase 2 step 3 introduced `WRITABLE_FIELDS` for routines that included server-managed fields (`splitFromRoutineId`, `lastGeneratedDate`, `routineExceptions`) and deprecated fields (`triggerMode`, `afterCompletionDelayDays`).

**Why:** these fields are written by `routes/calendar.ts` (split flow), `lib/routineItemRegeneration.ts` (generator), and `lib/calendarPushback.ts` (GCal exception sync). A caller PATCHing them can break recurrence generation or split history.

**How to apply:** when reviewing any new public-API write endpoint, cross-reference the entity's `WRITABLE_FIELDS` against `git grep -n "<fieldName>" src/` — if the field is written outside route handlers (in lib/ or scripts/ or by a sync engine), it's server-managed and should NOT be in the public allowlist. Also verify deprecated fields (marked `@deprecated` in `entities.ts`) are excluded from write surfaces.
