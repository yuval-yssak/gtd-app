---
name: regen-delta-claim-unmask
description: regenerateFutureRoutineItems delta reconcile can unmask a done-item's date-claim when a live item shares the same date, recreating a disposed occurrence
metadata:
  type: project
---

`regenerateFutureRoutineItems` (routineItemRegeneration.ts) reconciles by occurrence date. `requiredDatesNotAlreadyClaimed` builds `claimedByOthers` from ALL non-trash items (done/transformed/other-routine/live), then deletes every `liveByDate` date so a routine's own live item isn't self-vetoed.

**The trap:** `Set.delete(date)` removes the date entirely regardless of how many items contributed it. If a date D has BOTH a live item (this routine) AND a done item (this routine), deleting D for the live candidate also erases the done item's veto → D becomes "required" → if the live item drifts (trashed) a fresh row is created on D alongside the existing done row. Defeats the "done/transformed items keep their date claim" invariant.

**Why:** narrow — requires a live + done item coexisting on one date for one routine (shouldn't happen via normal flow, but possible with imported/legacy data). The prior trash-all-then-recreate did NOT have this gap (it never deleted dates from the claimed set).

**How to apply:** when reviewing this delta-reconcile family, check that excluding a routine's own live items from the claim-veto does so per-(date, item-identity), not per-date-globally. A fix would key the veto removal on whether the live item itself is the claim source, or exclude only when no done/transformed item also holds the date. Relates to [[project_gcal_perpetual_noop_routine_updates]] (this whole rewrite exists to kill that churn).
