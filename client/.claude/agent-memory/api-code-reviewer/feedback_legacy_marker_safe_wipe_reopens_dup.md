---
name: legacy-marker-safe-wipe-reopens-dup
description: The "safe wipe" fallback for lastKnown* calendar markers with unknown origin re-opens the gtd*-clone duplicate bug for any marker stamped before the accountEmail field shipped — a transitional regression, not a permanent one.
metadata:
  type: feedback
---

The GCal reconnect repair (`reconcileLastKnownMarkers`) decides same-account-rewrite vs orphan-wipe by comparing the marker's `lastKnownCalendarAccountEmail` to the reconnected integration's `accountEmail`. Both fields are NEW. The fallback for an absent/unknown marker email is the WIPE path — which is exactly what mints a `gtd*` clone master alongside the real one (the very bug being fixed).

So: any disconnect that happened BEFORE this change deployed stamped a marker with no email. A subsequent same-account reconnect of that marker still hits the old buggy wipe. The fix only protects disconnects that occur AFTER deploy. This is acknowledged in the code comments as "legacy → safe wipe", but "safe" is misleading — for a genuine same-account legacy marker the wipe is the unsafe branch.

**Why:** the email is the only signal distinguishing the two cases; without it there is no safe default that protects both same- and cross-account reconnects. The author correctly chose wipe (prevents the permanently-un-pushable case) over rewrite.

**How to apply:**
- When reviewing this calendar code, treat the legacy-marker case as a known transitional gap, not a bug to block on. Confirm the comment names it honestly.
- The MongoDB semantics that make the two filters disjoint+exhaustive: rewrite uses `lastKnownCalendarAccountEmail: liveEmail` (exact); wipe uses `{ $ne: liveEmail }` which ALSO matches missing fields. Verify any future edit preserves this — a `$exists`/`$ne` mismatch would leave legacy markers in neither set (never repaired) or both (double-op).
- Tests named "cross-account" in calendar.test.ts may actually be same-account-with-legacy-marker (same authorized email, no marker email). The name describes intent, not the literal scenario — check the email fields, not the title.
