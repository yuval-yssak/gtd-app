---
name: calendar-sync-now-stamped-outside-lock
description: All three calendar sync entry points capture `now` before acquiring the per-calendar mutex; only the manual-sync route has been fixed, the webhook and catch-up routes still backdate under lock contention
metadata:
  type: project
---

`withSyncLock` (KeyedMutex, keyed per calendar) serializes calendar syncs, and queue depth is
unbounded. Any caller that stamps `const now = dayjs().toISOString()` BEFORE entering the lock
writes `createdTs` / `updatedTs` / op `ts` from whenever the request arrived, not when it ran.
On staging the manual-sync queue backed up ~85 minutes during a push-notification storm, so
every queued run wrote timestamps 85 minutes stale — losing LWW against every real device edit
and (worse) planting op `ts` values below devices' forward-only pull cursors.

**Why:** the client service worker triggers `POST /calendar/integrations/:id/sync` in response to
each web push. A sync loop that emits a push per cycle therefore feeds itself, and the lock queue
is the amplifier that turns a modest bug into hours of backdated writes.

**How to apply:** three call sites take this lock. As of the "ALL HANDS" fix only the first was
corrected:
- `POST /integrations/:id/sync` (calendar.ts) — FIXED, stamps `startedAt` inside the lock callback
- `runWebhookSync` (calendar.ts) — still stamps `now` before `withSyncLock`; this is the HIGHER
  volume path, and its coalescing `while` loop reuses the same stale `now` across re-runs
- `renewWebhookAndCatchUp` (calendar.ts) — same pattern

When reviewing any change to these handlers, check that the clock read is inside the lock, and
that whatever `now` is reused afterward (SSE notify ts, `notifyViaWebPush`, `runMissedPushSweep`
`before` fence) is still the value the reviewer expects. The sweep fence in particular wants the
EARLIEST inbound stamp; anything later re-pushes rows the sync itself just wrote.

Related: [[op-cursor-ordering-invariants]], [[gcal-moved-row-foreign-date-class]]
