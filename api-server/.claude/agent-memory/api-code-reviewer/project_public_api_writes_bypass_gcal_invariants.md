---
name: public-api-writes-bypass-gcal-invariants
description: New /v1 + MCP write capabilities keep widening what a caller can do to GCal-linkage fields, and the GCal pushback dispatcher treats "no calendarEventId + status calendar" as "create a new event" — so any new way to remove linkage silently orphans/duplicates GCal events
metadata:
  type: project
---

Recurring blind spot: every broadening of the public `/v1` item write surface (Phase 3 full-surface PATCH, the `null`-clears-optional-fields change, `gtd_batch`, bulk import) is reviewed against the Zod snapshot schema + the status×field matrix, but NOT against the GCal pushback dispatcher's implicit invariants.

The load-bearing invariant nobody restates: in `lib/calendarPushback.ts`, `handleItemPush` dispatches on presence/absence of `calendarEventId`. `status: 'calendar'` **without** `calendarEventId` means "app-created calendar item that has never been pushed" → mint a **new** GCal event. `hydrateCalendarDetachSnapshots` only fires for statuses in `CALENDAR_DETACH_STATUSES` (inbox/nextAction/waitingFor/somedayMaybe), so it does not cover an item that *stays* `calendar` while losing its linkage.

**Why:** the matrix marks `calendarEventId`/`calendarIntegrationId`/`calendarSyncConfigId` merely *optional* on `calendar`, so schema validation happily accepts a linkage-free calendar item. The GCal consequence (orphaned event on the user's real calendar + a fresh duplicate) is invisible to every unit test because the provider is stubbed or the pushback leg is fire-and-forget.

**How to apply:** whenever a diff adds a new path by which a caller can remove or overwrite `calendarEventId` / `calendarIntegrationId` / `calendarSyncConfigId` / `routineId` on a row whose status stays `calendar`, trace it through `maybePushToGCal` → `handleItemPush` before approving. Ask for either (a) a route-level refusal, (b) routing through the detach/`removeItemGCalPresence` path, or (c) an explicit test that pins the intended GCal side effect. Related: [[project_gcal_series_collision_family]], [[project_gcal_owned_field_addition_checklist]].

**Precedent (2026-09-16, `null`-clears-optional-fields review):** caught pre-merge and fixed with option (a) — the PATCH route grew a `PATCH_CALENDAR_LINKAGE_FIELDS` denylist excluded from `PATCH_CLEARABLE_FIELDS`, so the three linkage ids reject `null` with `400 not_clearable` and a message pointing at the status-transition gesture. The test that proves it asserts **zero ops recorded** for the rejected PATCH, which is the right shape for this bug family: it proves nothing reached the apply pipeline, hence pushback never fired, without needing a stubbed calendar provider. Reuse that assertion style for the next one.
