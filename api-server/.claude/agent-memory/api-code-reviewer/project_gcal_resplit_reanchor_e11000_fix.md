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

**How to apply / review checklist for this area:**
- reanchorResplitSuccessor emits a re-anchor op AND the caller's updateRoutineFromGCal emits a second update op same-cycle (both ctx.now). Converges but is a same-ms LWW tie group — see [[project_sync_same_ms_boundary_drop]].
- reanchorResplitSuccessor uses updateOne($set) then re-reads for the op snapshot — snapshot matches persisted state (avoids [[project_snapshot_replace_defeats_lww_on_concurrent_edits]] and [[project_upsert_set_id_immutable_drift]]).
- Both new tests drive the real POST /sync route (integration-seeded), so provider-not-called-style non-discrimination is not a risk here.
