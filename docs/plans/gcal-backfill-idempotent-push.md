# Plan: Idempotent GCal backfill push (match-existing-before-create)

> **Status:** Ready to execute in a fresh session. No code changed yet.
> **Repo:** `/Users/yuvalyssak/gtd` · **Project:** `api-server` (Hono/Node/TS backend)
> **Primary file:** `api-server/src/routes/calendar.ts`
> **Branch:** create a new branch off `main` before editing (do not commit/push without explicit approval).

---

## 0. TL;DR

When a user connects/reconnects Google Calendar, the outbound backfill can push a **brand-new
app-owned `gtd*` recurring event** to GCal for a routine that **already has a real (imported) twin
on the calendar** — producing a visible duplicate of every recurring meeting. Fix: before backfill
mints a `gtd*` id for a "naked" calendar routine, **match it against the calendar's real events and
relink instead of creating a clone**. Only create when no real twin exists (preserves the legitimate
"create routines in-app, then connect GCal" flow).

**Do NOT** "fix" this by gating the backfill query on `calendarIntegrationId: { $exists: true }` —
see §3 for why that is wrong and must not be re-attempted.

---

## 1. Background: how the bug was found (production incident, 2026-06-21)

On the **work** account (`yuval.yssak@winn.ai`, staging) every daily meeting showed **twice** on
Google Calendar. Investigation (DB on `gtdStagingDB`, browser on `calendar.google.com/calendar/u/2`):

- Each daily had a **real** GCal recurring event (native Google id like `3qp933p629fvlgob08faqdtaak`,
  with a room, status "Accepted") **and** an **app-pushed clone** (event id prefixed `gtd`, e.g.
  `gtd7d4049bb082dae164efb73336b266`, no location, user as sole organizer).
- In GTD there were **3 routine docs per meeting**: the original capped base (linked, `active:false`),
  the active split successor (same real eid, `active:true`), and a **dead orphan** (`eid=NONE`,
  `active:false`, `UNTIL`≈June-2026, **0 items**) — the app-side fingerprint of the routine that had
  once owned the `gtd*` clone but lost its link.

**Cleanup already performed (done — do not redo):**
- Deleted the 4 dead orphan routine docs via `mongosh` on `gtdStagingDB` (ids: `d3127cf1` Tech sync,
  `5382a68a` Eng-1, `e153d1ea` Eng-2, `e3b06c49` Team Leaders) with a guard
  (`active:false, calendarEventId not exists, items=0`). The 4 active successors are intact and linked.
- The user deleted the 4 `gtd*` duplicate series on GCal ("All events"). Verified gone on 2026-06-22
  (0 `gtd*` events in the DOM). Note: `gtd4d0fcb15fd6bde9ae3e3f396f7fd2` = "OOO — Family time" is a
  **legit** app-created event (live `[calendar]` item) — keep it; it is not a duplicate.

This plan fixes the **code** so the duplicate can't recur.

---

## 2. Root cause (verified against code)

- **Ordering is already correct.** In the manual-sync handler
  (`POST /calendar/integrations/:id/sync`, `calendar.ts:1341`), the per-config loop runs
  `syncSingleCalendar` → `importCalendarEvents` (inbound relink) **before** `runOutboundBackfill`
  (`calendar.ts:1385-1396`). The **webhook** path (`runWebhookSync`, `calendar.ts:4313`) calls
  `syncSingleCalendar` but **never** calls `runOutboundBackfill` → this is a **manual-sync-only** bug.

- **Inbound relink** (`findExistingRoutineForEvent`, `calendar.ts:2007`) already matches a "naked"
  routine to an imported event by **title + rrule + timeOfDay + duration** (the naked branch at
  `calendar.ts:2047-2064`) and relinks via `relinkRoutineToEvent` (`calendar.ts:2107`). It only fires
  for events **returned in the sync window**.

- **The gap:** a routine is still naked at backfill time only when its **real twin was not in the
  sync window** — chiefly the **incremental-delta** case: after disconnect/reconnect with a still-valid
  `syncToken` *and* a wiped `lastKnownCalendarEventId` marker (see `reconcileLastKnownMarkers`,
  `calendar.ts:435`, and the wipe at `calendar.ts:464`), the **unmodified** real master never
  re-imports. Inbound relink never fires; strong-key restore (`tryRestoreRoutineFromLastKnownEventId`,
  `calendar.ts:2073`) can't fire either (marker gone).

- **The clone gets minted:** `runOutboundBackfill` (`calendar.ts:1440`) selects the still-naked
  routine and calls `pushRoutineToGCalWithContext` (`calendarPushback.ts:820`), which calls
  `buildDeterministicGCalId` (`GoogleCalendarProvider.ts:155`) →
  ```ts
  export function buildDeterministicGCalId(entityId, integrationId) {
      const digest = createHash('sha256').update(`${entityId}:${integrationId}`).digest('hex');
      return `gtd${digest.slice(0, 29)}`;   // always "gtd"-prefixed
  }
  ```
  → `events.insert` creates a **second** recurring master next to the real one.

---

## 3. Rejected approach — DO NOT re-attempt

**Rejected:** add `calendarIntegrationId: { $exists: true }` to the backfill routine query
(`calendar.ts:1457-1465`).

**Why it's wrong:** a user can create `routineType:'calendar'` routines **in the app before connecting
GCal**, then connect — those routines have **no `calendarIntegrationId`** until linked (it is optional,
`entities.ts:248`; the client uses its presence as the "is this on a calendar" predicate, see
`client/src/tests/PendingReassignProvider.test.ts:89` asserting `toBeUndefined()` pre-link). Gating on
it would **permanently block** that legitimate flow — those routines would never reach GCal. The two
populations of naked routine — (a) genuine never-synced and (b) orphaned-but-real-twin-exists — are
**indistinguishable by local fields** once the marker is wiped, so the disambiguation **must** consult
GCal, not a local field.

---

## 4. The fix — Option B1: full master-list match before create

Before `runOutboundBackfill` mints a `gtd*` id for a naked routine, **fetch the default calendar's full
recurring-master list once** (only when ≥1 naked routine exists) and match each naked routine against
it using the **existing** naked-match logic. Real twin found → **relink** (link-only `$set`); no twin →
**create** as today.

**Why a full master list (not the in-hand sync snapshot):** if a routine is *still naked* after import
ran on the sync snapshot, its twin by construction wasn't in that snapshot (else inbound relink would
have caught it). A **full** master fetch (`listEventsFull`, `singleEvents:false`, `timeMin = startOfToday`)
returns **all live recurring masters** on the calendar, so a live daily-meeting twin (the production
symptom) is always seen and relinked. The only twins absent from a full master list are **already-capped/
ended** series — for those a create is harmless (no overlapping future instances) and is the correct
behavior for a genuine (a)-routine anyway.

**Cost:** one extra API call total per sync, gated on `routines.length > 0`. Respect `BACKFILL_PACE_MS`.

### Safety decisions baked in (each must be enforced + tested)
1. **Relink only onto OPEN masters** (`isOpenRrule`, used at `calendar.ts:2166`). A capped/historical
   master is treated as "no live twin" → create. This also avoids the stale-UNTIL merge gate entirely
   because relink uses a **link-only `$set`**, not the structural `updateRoutineFromGCal` path.
2. **Skip masters already backing a routine.** Reuse the `knownRoutineEventIds` set logic
   (around `calendar.ts:1593`) so the matcher never targets a master that import already routed —
   keeps it away from split base/successor pairs (no re-trigger of split-churn / convergence bugs).
3. **Only naked routines are eligible** (`calendarEventId`/`calendarIntegrationId` absent). Split
   participants always carry a `calendarEventId`/`calendarRebasedEventId`, so they're never matched.
4. **TOCTOU/E11000-safe.** `relinkRoutineToEvent` already guards with
   `calendarEventId: { $exists: false }, calendarIntegrationId: { $exists: false }`
   (`calendar.ts:2114`); on `matchedCount === 0` (concurrent webhook won) it returns `undefined` →
   fall through to `pushRoutineToGCalWithContext` (whose own re-read guard + `createOr409Relink` +
   `gcalCreationInFlight` prevent duplicates). Wrap the matcher's relink so an **E11000** (unique index
   `uniq_active_routine_per_gcal_series` on `{ user, calendarEventId, calendarIntegrationId }`, partial
   `active:true`, `routinesDAO.ts:~29`) is treated as "already claimed" → skip create.
5. **Webhook path stays untouched.** Do not add backfill to `runWebhookSync`.

---

## 5. Files & key line references (verify before editing — line numbers drift)

- `api-server/src/routes/calendar.ts`
  - `1341` — `POST /calendar/integrations/:id/sync` handler (manual sync)
  - `1385-1396` — calls `runOutboundBackfill` after the config loop
  - `1440-1479` — `runOutboundBackfill` (the routine query at `1457-1465`; push at `1472`)
  - `1494-1531` — `syncSingleCalendar` → `importCalendarEvents` at `1527`
  - `1561` — `fullSyncFrom(provider, calendarId, timeMin)` (full master fetch helper)
  - `~1593` — `knownRoutineEventIds` set (masters already backing a routine)
  - `2007-2065` — `findExistingRoutineForEvent` (naked branch `2047-2064`)
  - `2073-2100` — `tryRestoreRoutineFromLastKnownEventId`
  - `2107-2134` — `relinkRoutineToEvent` (TOCTOU-safe link-only `$set`)
  - `~2246` — `buildNakedTemplateMatch` (all-day-aware template match builder)
  - `2166` — `isOpenRrule` usage
- `api-server/src/lib/calendarPushback.ts`
  - `~436` — `PushOutcome` status union; `820` — `pushRoutineToGCalWithContext`; `~834/847` —
    `gcalCreationInFlight`, `buildDeterministicGCalId` call
- `api-server/src/calendarProviders/GoogleCalendarProvider.ts`
  - `155` — `buildDeterministicGCalId` (the `gtd` prefix); `listEventsFull` / `fullSyncFrom` source
- `api-server/src/dataAccess/routinesDAO.ts` — `uniq_active_routine_per_gcal_series` partial index
- `api-server/src/tests/calendar.test.ts`
  - `1681-1900` — existing backfill / Sync-now tests; `1707-1728` — "pushes unlinked calendar-type
    routines to GCal" (the regression guardrail to extend)

---

## 6. Ordered checklist — EDITS

1. **`calendarPushback.ts`** (`~436`) — add `'relinked'` to the `PushOutcome` status union.
2. **`calendar.ts`** — add `matchExistingMasterForRoutine(routine, masters, source, ctx)` near
   `relinkRoutineToEvent` (`~2107`):
   - Filter `masters` to **open** recurring masters (`isOpenRrule`) whose bare id is **not** in
     `knownRoutineEventIds`, with `title === routine.title`, extracted rrule equal to `routine.rrule`
     (UNTIL-normalized; but capped masters are already excluded by the open-only filter), and
     `buildNakedTemplateMatch(event, tz)` fields equal to the routine's template (timeOfDay+duration,
     or allDay).
   - On a **unique** match call `relinkRoutineToEvent(routine, event, source, ctx)`; catch E11000 →
     return `undefined`. Return the relinked routine or `undefined`.
3. **`calendar.ts`** — modify `runOutboundBackfill` (`1440`):
   - Keep the existing query guards (`calendarEventId`/`lastKnownCalendarEventId` `$exists:false`,
     `active: { $ne:false }`) — they are correct and orthogonal.
   - When `routines.length > 0`, **lazily fetch** the default calendar's full master list via
     `ctx.provider` (reuse `fullSyncFrom`/`listEventsFull`, `timeMin = startOfToday(tz)`).
   - Build a local `SyncContext` (`{ userId, now, ops: [] }`) + `CalendarSource`
     (`{ integration: ctx.integration, config: ctx.config }`) for the matcher.
   - Replace the routine push (`1472`) with **relink-first**: try
     `matchExistingMasterForRoutine`; if it relinks, record a `'relinked'` outcome; else
     `pushRoutineToGCalWithContext`. Fold matcher ops into `recordedOps`.
   - Add a `relinkedRoutines` count; keep `pushedRoutines` counting only `status === 'created'`.
4. **`calendar.ts`** — handler (`~1387`, `~1405`, `~1413-1419`): thread `relinkedRoutines` into the
   log line and JSON response.
5. Run the **api-server post-change checklist** (see §8).

---

## 7. Ordered checklist — TESTS (unit + e2e; every step needs both, per project rule)

Add to `api-server/src/tests/calendar.test.ts` inside the existing
`describe('POST /calendar/integrations/:id/sync')` block (reuse `insertIntegrationWithConfig`,
`makeRoutine`, `getUserId`, `authenticatedRequest`, and the `GoogleCalendarProvider.prototype` spies).

6. **(i-a) No-regression / genuine app routine, empty master list → CREATE.** Naked `makeRoutine`;
   stub `listEventsFull` → `{ events: [], nextSyncToken }`, `getExceptions: []`; spy
   `createRecurringEvent`. Assert `pushedRoutines === 1`, `createRecurringEvent` called once, routine
   gains `calendarEventId`/`calendarIntegrationId`/`calendarSyncConfigId`.
7. **(i-b) Non-matching master present → CREATE.** Master with a different title → still creates.
8. **(ii) Matching native-id master in full list → RELINK, no clone.** Master with native id
   `'real-native-gcal-id'`, matching summary + `recurrence` + start/duration. Assert
   `createRecurringEvent` NOT called; routine `calendarEventId === 'real-native-gcal-id'`;
   `pushedRoutines === 0` (`relinkedRoutines === 1`); exactly **one** routine on that event id
   (unique index holds); one op recorded.
9. **(ii-allday) All-day naked routine + all-day master → RELINK.** Exercises the
   `buildNakedTemplateMatch` all-day branch.
10. **(iii) Twin absent / capped-only master → CREATE.** Document inline that B1's full-master fetch
    is what makes "create" safe here (no live twin can be missed).
11. **(e2e) connect→sync→reconnect→sync with native twin present → NO duplicate `gtd*` master.**
    The production repro. Model the reconnect so the real master is NOT in the incremental delta but
    IS in the full master list; assert no `createRecurringEvent` and no `gtd*` id minted.
12. **(idempotency) Sync twice with twin present → relink once, second run no-op** (second run's query
    excludes the now-linked routine).
13. **(blast-radius) Existing tests stay green:** `npx vitest run src/tests/calendar.test.ts`
    (split-successor onboarding, all backfill tests `1681-1900`).

---

## 8. Post-change checklist (api-server) — must all pass

From repo `CLAUDE.md`. **Local MongoDB must be running** for the test suite
(`globalTeardown.ts` connects to `127.0.0.1:27017`; if down, `npm run test` fails on teardown only —
start mongo, e.g. `docker run -d -p 27017:27017 --name gtd-mongo mongo:7`, or `brew services start
mongodb-community`).

```bash
cd api-server
npm run lint:fix     # Biome — clean up ALL warnings (noNonNullAssertion etc.) same turn
npm run typecheck
npm run test
```
Then invoke the **`api-code-reviewer`** subagent (mandatory; canonical def in
`api-server/.claude/agents/code-reviewer.md`). If it returns "Changes requested", fix and repeat the
full cycle. Task is not complete until it returns **Approved**.

E2E (if any spec under `e2e/` is touched): `cd e2e && npm run lint:fix && npx playwright test <changed specs>`.

---

## 9. Open questions for the executor to confirm with the user (optional)

- **(a) B1 cost** — one extra full master fetch per sync (only when naked routines exist) vs. reusing
  only the in-hand snapshot (cheaper but does NOT fix the incremental-delta case). Plan chooses B1.
- **(b) Create-when-twin-absent (case iii)** — plan chooses CREATE, relying on the full master fetch
  to guarantee live twins are always seen. Confirm this is acceptable vs. a more conservative "skip +
  surface for manual review."

---

## 10. Related prior findings (context)

These memories under `~/.claude-personal/projects/-Users-yuvalyssak-gtd/memory/` describe adjacent
bugs the fix must not re-trigger:
- `project_gcal_import_pushes_duplicate_gtd_series` — this incident's root-cause writeup.
- `project_gcal_reconnect_pushback_duplicates`, `project_gcal_reconnect_strands_unmodified_events`
  — the upstream syncToken/reconnect behavior that leaves a routine naked.
- `project_gcal_self_referential_split_churn_fix`, `project_gcal_split_chain_convergence_fix`,
  `project_gcal_stale_until_locked_by_updatedts_churn` — split/stale-UNTIL hazards the safety
  decisions in §4 are designed to avoid.

Untracked debug scripts already in the repo encode the author's understanding and may help:
`api-server/src/scripts/probeGcalDuplicates.ts`, `api-server/src/scripts/deleteCloneRoutines.ts`.
