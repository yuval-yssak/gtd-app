---
name: create-on-miss-no-dedupe
description: applyExceptionToItems create-on-miss has no unique index or in-flight guard; concurrent webhook + manual sync can double-create an orphan-exception item
metadata:
  type: project
---

`applyExceptionToItems` falls back to `createItemForOrphanedException` when both tiers of `resolveExceptionTarget` miss. There is no unique index on `(user, calendarInstanceEventId)` and no in-flight set guarding concurrent creates the way `gcalCreationInFlight` guards push-side mints. Two near-simultaneous sync passes (e.g. manual `POST /calendar/integrations/:id/sync` racing a webhook fire for the same config — webhook coalescing only dedupes by channelId, not against manual sync) can both miss and both insert.

**Why:** Q2 added a create-on-miss fallback so a "moved twice" instance is never silently dropped — but the fallback opens a new "silently duplicated" failure mode that's strictly worse for the cross-account-reconnect case (see [[lastknown-marker-orphan-risk]] interaction: stale `calendarInstanceEventId` survives `clearOrphanedLastKnownMarkers`, so the second move always misses preferred + fallback and duplicates instead of just losing the move).

**How to apply:** When reviewing the create-on-miss path or any new inbound-sync create, demand either (a) a unique partial index on the resolution key, (b) an upsert pattern (e.g. `findOneAndUpdate` with `upsert: true`), or (c) explicit mutual exclusion between manual and webhook sync for the same config. Cross-link to [[lastknown-marker-orphan-risk]] when the cross-account vector is in play.
