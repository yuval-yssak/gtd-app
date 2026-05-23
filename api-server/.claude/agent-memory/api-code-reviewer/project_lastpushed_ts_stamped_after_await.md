---
name: lastpushed-ts-stamped-after-await
description: Calendar pushback paths stamp lastPushedToGCalTs AFTER awaiting the GCal mutation, which can exceed the 5-second echo window on slow PATCHes and cause own-echo webhooks to re-apply identical snapshots.
metadata:
  type: project
---

`isOwnEcho` in `api-server/src/routes/calendar.ts` uses `ECHO_WINDOW_SECONDS = 5` and `Math.abs(dayjs(eventUpdated).diff(dayjs(lastPushedTs), 'second')) < 5`. New pushback paths (Phase 3 RSVP, and likely future write endpoints) compute `lastPushedToGCalTs = dayjs().toISOString()` AFTER `await provider.patchEvent…`. Google's `event.updated` is server-stamped when the PATCH lands, so a slow patch (250–500ms+) plus Pub/Sub delay can push the inbound webhook beyond the 5s window even though it's the same write echoing back.

Effect: a no-op snapshot rewrite + extra op-log entry per pushed write. Compounds with [[project_gcal_perpetual_noop_routine_updates]] when webhook fan-out is high-volume.

**Why:** `events.patch` does not return the updated event by default, so we can't anchor against `data.updated` without an extra GET or `fields` param. The drift is most visible on RSVP because the local-mutation step happens AFTER the await, not before.

**How to apply:** On any new endpoint that issues a GCal write then stamps `lastPushedToGCalTs`, recommend either (a) stamping BEFORE the await (slightly broader window, no overhead), or (b) switching the provider method to return the resource and stamping from `data.updated`. Flag if you see `lastPushedToGCalTs = dayjs().toISOString()` immediately after `await provider.{patch,update,insert}…`.
