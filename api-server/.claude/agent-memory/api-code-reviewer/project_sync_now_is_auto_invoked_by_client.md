---
name: sync-now-is-auto-invoked-by-client
description: POST /calendar/integrations/:id/sync ("Sync now") is called by the web client on EVERY syncAndRefresh, so "manual only / nothing replays automatically" doc claims are false; SyncIssuesPanel has no Reconnect button
metadata:
  type: project
---

`AppDataProvider.syncCalendarIntegrationsForActiveSession` POSTs `/calendar/integrations/:id/sync` for every integration on each `syncAndRefresh` (mount, online, PWA resume, SW `sync-complete`, settings actions), in addition to the Settings "Sync now" button. So the missed-push sweep + outbound backfill effectively run on every app sync cycle from an open client; only server-side triggers (webhook, OAuth callback, cron) never run them.

Also (verified 2026-09-25): SyncIssuesPanel renders only Retry (when `retryable`) + Dismiss — there is NO Reconnect affordance for `scope_missing`, despite `gcalErrorCategorization.ts` docstring saying so. `categorizeGCalError` never returns `calendar_missing`. `/sync/issues/:id/dismiss` DELETES the op row, it doesn't just clear markers.

Round 2 (2026-09-25): webhook deliveries (`runWebhookSync`) and the `/webhooks/renew` cron SKIP non-active integrations, so "inbound sync still attempts while suspended" is true only for the client-driven POST /sync. Suspended→revoked can also fire from user-driven routes that only 410 on `revoked` (list calendars, link-routine, sync-config create) — "only inbound syncs revoke" is false. The suspended-pushback skip IS tested (`calendar.splitDetection.test.ts`, "pushback against a suspended integration is a no-op") — don't accept "no test yet". `detachedCalendar` is filled by `hydrateCalendarDetachSnapshots` BEFORE `applyEntityOp`; `entity_missing` markers by `markOpNotApplied` in applyOperation.ts. Routine series pushes never read `gcalMeta`.

Round 3 (2026-09-25): after reconnect the `/webhooks/renew` cron (`renewWebhookAndCatchUp`) re-registers a lapsed channel AND runs a server-side catch-up inbound sync, so "no server-side trigger runs a fresh sync" is false; only backfill + missed-push sweep are client-driven. Also `/sync/issues` dismiss and retry-success DELETE the op from the log (retry deletes its fresh republished row in the same request), so a lagging/offline device never pulls that change (pre-existing, unfixed).

Round 4 (2026-09-25): "trash paths `$unset` calendarInstanceEventId" is only true for SERVER-side trash (routine delete, regen, inbound cancel, demote). Client `clarifyToTrash` spreads the item, so a user-trashed occurrence pushed via /sync/push keeps its instance id (isDemotableDeadTwin explicitly handles trash twins). Flag blanket "trash frees the instance id" wording.

Round 5 (2026-09-25): the "server-side vs in-app" split is ALSO wrong — `POST /v1/items/:id/trash` (MCP `gtd_trash_item`) is server-side but spreads `existing`, keeping the instance id. Correct axis is user-initiated trash (any surface) keeps it vs sync-engine/system trash (routine delete, regen, inbound cancel, dead-twin demote) frees it.

**Why:** a 2026-09-25 docs change set described "Sync now" as user-pressed-only, Reconnect as a panel affordance, and dismiss as marker-clearing — all wrong against code.

**How to apply:** when reviewing docs/comments about GCal repair paths or the SyncIssuesPanel, check client call sites (`client/src/contexts/AppDataProvider.tsx`, `SyncIssuesPanel.tsx`) before accepting "manual"/"Reconnect" wording. Related: [[project-gcal-pushback-failure-surfacing-coverage]].
