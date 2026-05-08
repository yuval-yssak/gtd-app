---
name: Routine split head-cap must bump updatedTs
description: Composite splitRoutine's buildCappedHead pattern often forgets to bump updatedTs on the head snapshot, silently losing the cap under any concurrent edit due to LWW.
type: project
---

`splitRoutine` (and any future composite that mutates an existing routine) builds a "capped head" snapshot from the existing routine and submits it as a routine.update op via the shared apply pipeline. The pipeline uses LWW on `snapshot.updatedTs`:

```
if (!existing || existing.updatedTs <= snapshot.updatedTs) replaceById(...)
```

If the cap snapshot does NOT bump `updatedTs`, the comparison falls back to equality on the *original* timestamp, and any concurrent op that writes the routine with a later `updatedTs` (between the find and the apply) silently wins — the cap is dropped, the route returns 200 with the capped body, but the DB still has the un-capped rrule. Devices replaying the op locally hit the same trap.

**How to apply:** On any composite routine handler that builds a snapshot from a DB read:
1. Verify `updatedTs` is bumped (passed `now` and stamped on the snapshot).
2. Test the persisted state, not just the response body — body equality with the input doesn't catch this.
3. The same trap applies if a future composite builds an item snapshot from DB and forgets to bump `updatedTs`.

CLAUDE.md's API-server section is explicit: *"`updatedTs` is the conflict-resolution anchor — it must be set to the current ISO datetime on every mutation. Never backdate `updatedTs`."*
