---
name: carry-forward-hydrator-skips-creates
description: Invariants enforced in hydrateItemCarryForwards never run on creates (no stored row) or on calendar.ts direct replaceById/updateOne revives
metadata:
  type: feedback
---

`carryForwardOne` in `lib/itemCarryForward.ts` early-returns when there is no stored row, so any "drop/normalize field X" rule hooked there does NOT apply to `create` ops (batch creates, /sync/push creates). Separately, GCal inbound revives in `routes/calendar.ts` (`reviveTrashedCalendarItem`, `reviveTrashedRoutineItemInPlace`) write via `replaceById` / `$set` and bypass the pipeline entirely, spreading `...existing`.

**Why:** found while reviewing `statusBeforeDone` (2026-10-28): an open-status create carrying the field persisted it (verified with a probe test), and `/v1` complete/PATCH build from `...existing` so the "incoming value wins" rule then trusts the stale stored value.

**How to apply:** when a feature claims an invariant "the pipeline guarantees field X never sits on rows of kind Y", check (1) create ops, (2) calendar.ts direct DAO writers, (3) server routes that build the snapshot from `...existing` and therefore always "carry" the stored value. See [[stale-snapshot-after-inplace-heal]].
