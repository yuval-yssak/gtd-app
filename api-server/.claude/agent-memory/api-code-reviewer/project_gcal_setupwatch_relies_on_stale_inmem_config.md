---
name: gcal-setupwatch-relies-on-stale-inmem-config
description: setupWatch's stale-channel stop depends on the in-memory config carrying OLD webhook ids; any callsite that re-reads config from DB after a clear, or runs setupWatch twice, can leak or double-stop
metadata:
  type: project
---

`setupWatch(config, ...)` (calendar.ts "Webhook watch management") became idempotent: it reads `config.webhookChannelId` from the **passed in-memory object** and stops that stale channel on Google before minting a new one. `teardownWatch` and `renewWebhookIfExpired` now delegate to the shared `stopChannelOnGoogle` helper; renew dropped its explicit teardown and relies on setupWatch to stop the stale channel.

**Why:** the orphaned-channel leak (staging notification storm follow-up to commit 25fa721) — every setup minted a fresh channel without stopping the previous one, so Google fan-out multiplied per orphan.

**How to apply when reviewing changes in this area:**
- The stop is correct ONLY because no callsite re-reads `config` from the DB (which would lose the old ids) between the field clear and setupWatch, and `syncSingleCalendar` never mutates `config.webhookChannelId`/`webhookResourceId` in memory. If a future change re-fetches config before setupWatch, or clears webhook fields first, the stale-stop silently breaks → leak returns. Grep `config.webhookChannelId` reads/writes on any change here.
- setupWatch callsites: POST sync-configs (~1010, fresh config, no stale id), PATCH enable (~1059, in-memory config still carries old ids — desired), renew in manual-sync (~1256), webhook-sync (~3784→renew), cron `/webhooks/renew` (~3829). All pass a config that legitimately carries the old ids when re-registering.
- The stop is best-effort + idempotent (`.catch(() => {})`), so a crash between stop and upsert leaves the OLD ids stored (recoverable: next setup stops them again) rather than cleared — strictly better for recovery than the old teardown-then-setup which left fields cleared on a mid-crash.
- Not user-scoped concern: `stopChannelOnGoogle` early-returns when channelId/resourceId is falsy, so no-webhook-field configs never call stopWatch.
