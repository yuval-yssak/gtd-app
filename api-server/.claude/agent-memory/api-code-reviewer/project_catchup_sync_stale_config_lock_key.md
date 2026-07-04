---
name: catchup-sync-stale-config-lock-key
description: FIXED 2026-07-02 — renewWebhookAndCatchUp re-reads config before withSyncLock. Pattern memo: any lock/sync keyed on a config after setupWatch rewrote its channelId must re-read first.
metadata:
  type: project
---

FIXED 2026-07-02: `renewWebhookAndCatchUp` now does `const fresh = await calendarSyncConfigsDAO.findOne({ _id: config._id })` (with `if (!fresh) return` for a concurrently-deleted config) after a `'renewedAfterLapse'` renewal, and runs the lock + sync + notify off `fresh`. Keeping this memo as a class-of-bug guard.

Original bug: `renewWebhookAndCatchUp` (calendar.ts) calls `renewWebhookIfExpired` → `setupWatch`, which writes a NEW `webhookChannelId` to Mongo via `upsertWebhookFields` but does NOT mutate the passed in-memory `config`. It then called `withSyncLock(config, …)`, and `syncKeyFor` reads the STALE `config.webhookChannelId`. A concurrent webhook delivery on the freshly-registered channel loads the config from DB (new id) and locks on a DIFFERENT key → the two syncs for the same physical calendar run concurrently, defeating the serialization the lock exists to provide (unique indexes still keep it correct, but you get the insert→E11000→merge churn back).

**Why:** This is the same class as [[gcal-setupwatch-stale-inmem-config]] — any re-registration that changes ids before a lock/sync keyed on the old in-memory config re-opens a concurrency hole.

**How to apply:** On any new code that (a) mutates webhook/channel ids in DB and then (b) locks or syncs off the same in-memory config object, demand a fresh `findById` (or thread the new id through the return value) BEFORE `withSyncLock`. Grep for `withSyncLock(config` where a `setupWatch`/`upsertWebhookFields` ran earlier in the same function.
