---
name: gcal-resplit-reanchor-e11000-fix
description: Third split-successor resolver (reanchorResplitSuccessor) + guarded reactivation fix for the staging E11000 re-split sync jam
metadata:
  type: project
---

Re-split ("this and all following" applied AGAIN) makes GCal report an open tail with a NEW `_R<anchor>` id, orphaning the stored `calendarRebasedEventId`. Fix on worktree-fix-gcal-sync-e11000 (calendar.ts):

- `reanchorResplitSuccessor` — 3rd resolver in the forceSplitSuccessor chain (after findSplitSuccessorByRebasedId + tryRestoreSplitSuccessorFromMarkers). Finds a successor on the same bare id with a different anchor, re-anchors it, records an `update` op, returns it as update target.
- `findActiveRoutineOnSeries` — active-slot holder finder (successors NOT hidden) used in createRoutineFromGCal's E11000 catch BEFORE findExistingRoutineForEvent.
- `isActiveSlotTakenByAnother` gates `newlyLosesUntil` reactivation; `replaceRoutineGuardingActiveSlot` retries once with active:false on our own inactive→active E11000.

**Why:** on re-split, findExistingRoutineForEvent's baseOnly filter hides successors → resolved the inactive base → newlyLosesUntil reactivated it → unguarded E11000 #2 aborted the whole sync; sync token never advanced so every retry died identically and one-off events never imported.

**MERGED with main fe24728 (independent fix of same bug) at c3b721e.** Main added importRecurringMasterIsolated (per-series try/catch → log+continue), its own findActiveRoutineOnSeries+rekeySuccessorRebasedId as a phase-2 fallback (line ~2494) and in the E11000 catch, and a splitFromRoutineId exclusion in baseOnly. Merge kept OUR reanchorResplitSuccessor as the 3rd `??` resolver (runs BEFORE main's activeOnSeries fallback) but simplified it to delegate its write to rekeySuccessorRebasedId. Kept our newlyLosesUntil slot gate + replaceRoutineGuardingActiveSlot (main didn't touch updateRoutineFromGCal).

**How to apply / review checklist for this area:**
- reanchorResplitSuccessor now delegates write to rekeySuccessorRebasedId → exactly ONE re-anchor op, plus rekey's idempotency short-circuit (no-op when anchor unchanged). Its `$exists:true` query means it only catches successors that ALREADY have an anchor; legacy anchor-less active successors fall through to main's activeOnSeries fallback — complementary, no coverage loss. Ordering (ours first) is safe: both delegate to rekey+updateRoutineFromGCal; ours ADDS the capped-successor-no-active-holder case main's active-only fallback misses.
- **Fault isolation defeats the `200`-status discriminator.** importRecurringMasterIsolated swallows per-series throws, so the slot-race test returns 200 even if replaceRoutineGuardingActiveSlot's retry throws. The REAL discriminator is `base.rrule` becoming the OPEN rrule (retry preserves the open rrule on keptInactive; a broken retry leaves the capped UNTIL rrule). That assert IS present — keep it. Any future test in this file relying on 200 to prove a routine-import path worked is non-discriminating.
- reanchorResplitSuccessor + updateRoutineFromGCal still emit two ops same-cycle (both ctx.now) — same-ms LWW tie group, see [[project_sync_same_ms_boundary_drop]]. Converges.
- All 4 of our tests drive the real POST /calendar sync route (integration-seeded), assert persisted DB state.
