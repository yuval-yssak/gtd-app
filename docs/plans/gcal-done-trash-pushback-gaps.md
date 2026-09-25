# GCal done/trash markers lost while integration suspended — fix + repair plan

Status: **draft for approval** (2026-09-25). Diagnosis session:
https://claude.ai/code/session_016Jc5Rhsjhp6nsS89bGFXUr. Branch: `fix/gcal-suspended-pushback-gaps`
off `main`. Ships → `staging` (deploy) → `main`. Each step ends with the repo checklist green
(`lint:fix` → `typecheck` → `test` → reviewer subagent Approved) with unit **and** Playwright
coverage, and waits for explicit commit approval. Never commit or push without per-change approval.

Answer the open decisions in § Decisions inline, then say "execute" in a fresh session — the
executor re-reads this file first.

## What went wrong (evidence summary — do not re-derive)

Environment: staging, user `69fc8e80e72f5ac01d96c926`, work integration
`152e5d5a-6463-44f0-81c0-b92f04858810` (calendar `yuval.yssak@winn.ai`, TZ `Asia/Jerusalem`), sync
config `116ac1d7-ab92-4c60-bfbd-df7f8207e112`. Cloud Run service `gtd-api-staging`, GCP project
`gtd-app-project-491308` (`gcloud logging read … --account=yuval.yssak@gmail.com`; the winn.ai
account has no log access). Staging Mongo: URI in `~/.config/gtd/staging-mongo-uri`, DB
`gtdStagingDB` (`db.getSiblingDB`), owner field on items is `user`.

1. **Suspension window.** `invalid_grant` at `2026-09-23T13:41:24Z` → `[calendar-auth] suspended
   integration 152e5d5a…` (24 h grace, `lib/calendarAuthEscalation.ts:40-68`). Reconnected at
   ~`14:13:20Z`. Every item op from Chrome device `04fe1386-6fc4-4c7d-bea4-109936e1b9a0` between
   13:45 and 13:57Z logged the pair `[gcal-pushback] op=update …` / `[calendar-pushback] skipping
   suspended integration …` and nothing else.
2. **Defect 1 — silent drop.** `resolvePushContext` returns `null` for a non-active integration
   (`lib/calendarPushback.ts:1166-1169`); `pushRoutineInstanceOverride` (:313-315),
   `pushRoutineInstanceCancellation` (:403-405), `pushExistingItemToGCal` (:493-495) and
   `removeItemGCalPresence` (:219-221) return `undefined`; `surfacePushFailure` (:139-144) only marks
   ops whose outcome is `failed` → no `syncFailed`, no SyncIssuesPanel row, no Retry.
3. **Defect 2 — sweep coverage.** The reconnect ran `runMissedPushSweep` 3× (candidates 13/6/1,
   three concurrent `POST /calendar/integrations/:id/sync` from open tabs; route at
   `routes/calendar.ts:1300`, sweep call :1391). It re-pushed the 9 standalone events (they now carry
   `lastPushedToGCalTs = 2026-09-23T14:13:xx`). Routine instances were never candidates:
   `collectRoutineInstanceMissedPushes` (:1376-1390) requires a `modified` routineException carrying
   `itemId`, which only the client writes on an in-app move
   (`client/src/db/itemMutations.ts:429-449`); inbound exceptions never carry it
   (`routes/calendar.ts:4563-4585`); this user has **0** such exceptions. Both collectors exclude
   `trash` (:1399, :1464). Result: 18 routine-instance rows from the window have **no**
   `lastPushedToGCalTs` at all.
4. **Defect 3 — inbound moves skip done rows (group B).** `resolveExceptionTarget` scopes all three
   tiers to `status:'calendar'` (:4727, :4749, :4794). A Google move onto a done row →
   `createItemForOrphanedException` (:4985) → orphan insert **E11000** on the presence-partial
   `(user, calendarInstanceEventId)` index (not status-scoped) → `handleOrphanInsertDuplicate`
   (:5046) → `isDemotableDeadTwin` (:5066) requires a *foreign* routine → `applyExceptionAfterDuplicate`
   (:5107) re-resolves with the same filter → `warn "index hit but re-resolve missed"` and bail.
   Logged at `2026-09-23T21:49:12Z` (routine `579d12ee`, `q3eq…_20260924T071500Z`) and
   `23:36:46Z` (routine `b8537e47`, `28s9…_20260924T070000Z`). One-shot loss: `getExceptions` uses
   `timeMin = max(since, now-30d)` (:5362-5365) so a past instance is never re-reported.
   `isExceptionBeforeToday` (:4647) was **not** involved (both syncs ran the same local day).
   Future-dated done rows re-log the same warning on every webhook (`6b8e109a` 29 Sep, `dd5db075`
   8 Oct) — noise, and a latent B if Google moves them.
5. **Defect 4 — inbound cancellation skips done rows (group D).** `applyExceptionToItems` for
   `deleted` (:4666-4675) writes via `target.filter` (`status:'calendar'`) → `updateItemsAndRecordOps`
   finds 0 ids and returns (:4610-4614). No log line on this path. `skipped` exception for
   `b3523952` / 2026-09-24 first stored `2026-09-23T21:49:36Z`.
6. **Group C intent gaps.** Trash of a routine instance → `pushRoutineInstanceCancellation` →
   `patchInstanceById(status:'cancelled')` (`calendarProviders/GoogleCalendarProvider.ts:721-729`),
   `sendUpdates` hard-defaulted `'none'` (:744-748); `handleItemPush` (:259-263) does not forward
   `op.gcalMeta.sendUpdates`; no past-occurrence or organizer guard. The client never asks:
   `shouldFireSendUpdatesDialog` requires post-edit status `calendar`
   (`client/src/components/itemEditor/sendUpdatesDialogLogic.ts:44-46`). Also
   `pushRoutineInstanceCancellation:392` skips **inactive** routines (latent: trashing an occurrence of
   a split's capped base never cancels it on Google).
7. **Ruled out:** split `_R` ids (instance ids stay bare-prefixed; override path has no `active`
   check), a future-instance guard (none), Lunch series `updated 11:41:35Z` (our own instance patch
   on Lunch-22 bumping the master), naive timestamps (irrelevant while `calendarInstanceEventId`
   present; latent: `resolveOriginalDate` :449-455 formats under `TZ=UTC`).

Affected staging rows (all `status: done` unless noted, all lack `lastPushedToGCalTs`):

| Group | item `_id` | routine | GTD time | Google now |
|---|---|---|---|---|
| A1 | `bb92a2e8-62cb-4c9c-bae7-b342a5ae3ea8` | `c63580e0…` (inactive, capped base) | 20 Sep 10:15 | same, no ✓ |
| A2 | `35160f87-66dd-4a10-8ff8-87b518958935` | `c63580e0…` | 21 Sep 10:15 | same, no ✓ |
| A3 | `ddea8f63-4764-4002-b47e-770560bc7645` | `c63580e0…` | 22 Sep 10:00+03:00 | same, no ✓ |
| A4 | `48ed5065-c446-4c07-a5c7-58fd0f1500e8` | `b8537e47…` | 22 Sep 10:15+03:00 | same, no ✓ |
| A5 | `130da07a-b8a0-4407-91bb-5f704589dd84` | `090f5166…` | 22 Sep 16:30+03:00 | same, no ✓ |
| A6 | `e780c52d-d0ac-48f1-bc87-6ca23eb1c634` | `1af53c96…` Lunch | 24 Sep 12:00 | same, no ✓ |
| A7 | `316da22c-1257-4c02-826e-e9128a06a45b` | `8d8aa02a…` | 24 Sep 16:00 | same, no ✓ |
| B1 | `fdbda589-31e0-4ce3-b984-24ae4bb70796` | `b8537e47…` | 24 Sep 10:00–10:10 (stale) | **09:15–09:25**, no ✓ |
| B2 | `c4eec141-007f-481f-897d-9a6fd97bb9eb` | `579d12ee…` | 24 Sep 10:15–10:30 (stale) | **11:15–11:30**, no ✓ |
| C1 | `d86d5d91-d1c2-462f-beab-d8f88e986a0f` (trash) | `3815c6e1…` Team Weekly | 22 Sep 13:15+03:00 | still present; you organize, 3 guests |
| D1 | `22a587e4-fa0f-4bc0-a68f-6874c8756f5d` | `b3523952…` | 24 Sep 09:45 | occurrence cancelled |

Same-window rows outside the report that the sweep fix will also repair: `4834e1f4…` (RND 15 Sep),
`212a0e03…`, `dea646ae…`, `c9426093…` (Team Leaders 15/16/17 Sep), `88802380…` (Team Weekly 15 Sep),
`f9c92ef6…` (Yuval<>Gilad 29 Sep), `7ccc2172…` (Upcoming POCs 8 Oct).

## Decisions

Answer under each question (leave the question text; write the answer on the next line).

**Q1 — Group D: when Google cancels an occurrence whose GTD row is already `done`, what happens to the row?**
Recommended: trash it (a ✓ on an occurrence that never happened is a phantom completion; the
`skipped` exception + freed instance id keep the series consistent). Alternative: keep `done`,
only `$unset calendarInstanceEventId`.
Answer: trash.

**Q2 — Group C: trashing a routine occurrence that is already in the past — cancel it on Google or not?**
Recommended: **do not** cancel past occurrences on Google (the meeting happened; for organizer-owned
events the cancellation rewrites guests' history); keep the GTD trash local and log a skip. Future
occurrences keep today's behaviour (instance cancelled).
Answer: cancel anyway (no past-occurrence skip; Step 5's Q2 bullet is dropped).

**Q3 — Group C: for a *future* organizer-owned occurrence with guests, should trash surface the SendUpdatesDialog and forward the choice?**
Recommended: yes — extend the client gate so status→`trash` with attendees where `self` is the
organizer fires the dialog, and thread `gcalMeta.sendUpdates` through `pushRoutineInstanceCancellation`
/ `removeItemGCalPresence` / standalone delete. Alternative: keep silent `'none'` (today's behaviour).
Answer: show the dialog. Mirror Google exactly: it only asks (and only emails guests) for events
that have not ended yet; deleting a past event with guests is silent. Executor: verify this on the
test calendar (`yuval.gtd.test@gmail.com`) before wiring the gate, and record the observed rule here.

**Q4 — Should the inactive-routine skip in `pushRoutineInstanceCancellation:392` stay?**
Recommended: replace the blanket skip with the paused-routine check it was written for
(`routine.active === false` **and** the op batch carries a routine pause; see the comment at :367-371)
— a split's capped base is inactive but its master still holds the past occurrences, so a trash
there should cancel by instance id. If unsure, answer "keep" and it becomes a follow-up.
Answer: narrow it per the recommendation (paused routines skip; split-capped bases cancel by instance id).

**Q5 — Repair of C1 (Team Weekly 22 Sep, past, you organize, 3 guests).**
Options: (a) leave Google untouched (consistent with Q2 recommended); (b) cancel the instance via
the app after the fix (guests' calendars lose it silently); (c) you delete it in Google by hand.
Answer: copy Google's behaviour. C1 is a past occurrence → the sweep cancels it on Google with
`sendUpdates:'none'`, no dialog (the row is already trashed; a sweep push has no `gcalMeta`).

## Ground truth the executor relies on

- Pushback entry: `maybePushToGCal` (`lib/calendarPushback.ts:89`) is called fire-and-forget from
  `lib/notifyChange.ts`; outcomes funnel through `captureFailedOutcome` (:157) and
  `surfacePushFailure` (:139) → `markOpFailed` (`lib/opFailure.ts:12`) with an `OpFailureReason`
  (`types/entities.ts:560`: `transient_exhausted | scope_missing | calendar_missing | edit_conflict |
  terminal | entity_missing`). `scope_missing` renders the **Reconnect** affordance; the panel's Retry
  (`routes/syncIssues.ts`) re-fires `maybePushToGCal` with the stored op.
- Integration status helper `lib/calendarIntegrationStatus.ts` (`integrationStatus()` coerces missing
  → `active`). DAO `markSuspendedIfActive` / `markRevokedIfSuspended`
  (`dataAccess/calendarIntegrationsDAO.ts:144-165`); `upsertEncrypted` (:34) clears escalation
  fields on reconnect.
- Sweep runs **only** inside `POST /calendar/integrations/:id/sync` (`routes/calendar.ts:1391`),
  after the inbound pass, fenced by `before: now`. Anchor test `isMissedPush` (:1315):
  `updatedTs > max(lastPushedToGCalTs, lastSyncedFromGCalTs, fallback)`. Routine-instance done
  rows carry `lastSyncedFromGCalTs` from creation, so an anchor exists.
- `pushRoutineInstanceOverride` (:289-360) always sends `timeStart/timeEnd` (:338-339). **Re-pushing
  a done row whose Google instance moved afterwards would move it back** — the sweep must not send
  times unless the row was locally moved.
- Provider instance patch: `updateRecurringInstance` / `cancelRecurringInstance` prefer
  `options.instanceEventId` (`GoogleCalendarProvider.ts:698`, :724); `patchInstanceById` treats 404 as
  warn-and-skip (:744-756) — cancelling an already-cancelled/gone instance is idempotent.
- Inbound exception pipeline: `reconcileAndApplyRoutineExceptions` (:5429) → `applyExceptionToItems`
  (:4660) per reported exception; `applyModifiedExceptionToMatches` / `buildModifiedExceptionPatch`
  (:4836+) apply `sharedFields` under an `updatedTs` guard (`applyModifiedExceptionToOne`, :4937).
  Dev driver for tests: `POST /dev/calendar/simulate-routine-exception-sync`
  (`routes/devLogin.ts:533`), which takes a caller-supplied `reported` set.
- Test harness: `src/tests/calendarTestKit.ts` (`insertIntegrationWithConfig`, `makeItem`,
  `makeRoutine`, `makeOp`, `mockBuildProvider`, `spyOnGCalEventsApi`, `useCalendarTestLifecycle`);
  sweep tests in `src/tests/missedPushSweep.test.ts`; pushback tests in
  `src/tests/calendar.pushback.test.ts`; exception tests in `src/tests/calendar.applyException.test.ts`.
  Add to the topical file, not a new mega-file. Tests need `docker run -d --rm --name gtd-test-mongo
  -p 27017:27017 mongo:8.0`; no outbound HTTP (unmocked provider methods reject with `AbortError`).
- E2E pattern for Google-side behaviour: dev endpoints under `/dev/calendar/*` with a stub provider
  that records calls (`simulate-relink-sweep` at `devLogin.ts:605` is the template); `seed-integration`
  (:321) creates an integration+configs. Specs live in `e2e/calendar-*.spec.ts`; `sync-issues-panel.spec.ts`
  covers the panel. Always `await gtd.flush()` before `page.goto()` after a `gtd.*` mutation.
- Client: trash gesture `client/src/db/itemMutations.ts:253`; `addCalendarException` (:293) writes
  `skipped`; `recordRoutineInstanceModification` (:429) writes `modified` + `itemId`;
  `gcalMeta` type `client/src/types/MyDB.ts:394`; dialog gate `sendUpdatesDialogLogic.ts`;
  editor wiring `ItemEditorBody.tsx:698-720, 886-894`.

---

# Step 1 — Suspended/revoked pushback surfaces as a `scope_missing` failure

Goal: an op whose GCal push is skipped because the integration is not `active` lands in the
SyncIssuesPanel with **Reconnect**, and Retry after reconnect re-fires it.

Files:
- `api-server/src/lib/calendarPushback.ts`
  - Introduce a typed marker error `IntegrationNotActiveError` (status + integrationId) thrown (or
    returned as a `failed` outcome) from `resolvePushContext` / `resolveDefaultPushContext` when
    `integrationStatus(integration) !== 'active'` (:1166-1169, :1256-1259). Keep the log line.
  - Every caller that today does `if (!ctx) return;` after a not-active context must propagate a
    `{ status: 'failed', failureDetail: 'Google Calendar integration is suspended — reconnect to
    resume sync', failureError }` outcome: `removeItemGCalPresence`, `pushRoutineInstanceOverride`,
    `pushRoutineInstanceCancellation`, `pushExistingItemToGCal`, `pushNewItemToGCal`,
    `pushRoutinePause/Resume`, `pushRoutineDeletion`, `pushExistingRoutineToGCal`,
    `pushNewRoutineToGCal`. Simplest: let the marker error throw and rely on the existing
    `captureFailedOutcome` wrappers (every branch of `handleItemPush`/`handleRoutinePush` is wrapped);
    the "genuinely unlinked" `null` cases (no config, no fallback) stay `null`/`undefined`.
  - `resolveTimeZoneForRoutine` and the sweep's read-only probes must **not** throw on the marker —
    catch and return `undefined` there.
- `api-server/src/lib/gcalErrorCategorization.ts` — map `IntegrationNotActiveError` →
  `'scope_missing'`.
- `api-server/src/lib/calendarPushback.ts` `runMissedPushSweep` — a `failed` outcome with the marker
  means the sweep itself ran against a non-active integration; log once and stop (don't loop 150 ms
  per candidate).

Tests (unit, `src/tests/calendar.pushback.test.ts` + `src/tests/calendarAuthEscalation.test.ts`):
- For each of: standalone done, standalone trash, routine-instance done, routine-instance trash,
  detached-calendar op, item delete op, routine update — seed the integration with `status:
  'suspended'`, run `maybePushToGCal`, assert the op is `syncFailed` with `failureReason:
  'scope_missing'` and the provider was **not** called. Same with `status: 'revoked'`.
- Active integration: existing tests unchanged (no new failures).
- Retry path: `POST /sync/issues/:opId/retry` (or whatever `routes/syncIssues.ts` exposes) after
  flipping the integration back to active → provider patch called, op cleared.
- Prove each new test fails with the fix disabled (memory rule: verify by instrumenting).

E2E (`e2e/calendar-suspended-pushback.spec.ts`, new): seed integration via `/dev/calendar/seed-integration`,
add a dev endpoint `POST /dev/calendar/set-integration-status {integrationId, status}` (new, in
`devLogin.ts`), create a routine-generated calendar item, set status `suspended`, mark the item done in
the UI, open the SyncIssuesPanel → row with the Reconnect affordance and the item title; set status
`active`, click Retry → row disappears. (The e2e API runs with the network guard; if the provider call
needs a stub, extend `set-integration-status` with a `stubProvider: true` mode that swaps
`buildCalendarProvider` for a recorder, mirroring `simulate-relink-sweep`.)

# Step 2 — Anchor-based missed-push sweep that covers routine instances and trash

Goal: one "Sync now" after a reconnect repairs every dropped ✓/green, cancellation and delete.

Files: `api-server/src/lib/calendarPushback.ts` (§ Missed-push sweep, :1296-1472).
- `collectRoutineInstanceMissedPushes` → query items `{ user, calendarIntegrationId,
  calendarInstanceEventId: {$exists:true}, status: {$in:['calendar','done','trash']},
  lastKnownCalendarEventId: {$exists:false}, updatedTs: {$lt: before} }`, join their routine
  (`calendarEventId` present, same integration or healed), keep rows where
  `isMissedPush(item, routine.lastSyncedFromGCalTs)`. Keep the `exception.itemId` collector as a
  legacy fallback for rows without an instance id (it also backfills the id) — dedupe by `_id`.
- `collectStandaloneMissedPushes` → include `trash`.
- **Time-clobber guard:** add an option to `pushRoutineInstanceOverride` (`{ omitTimes: true }`)
  used by the sweep unless the routine has a `modified` exception with `itemId === item._id`
  (the row was locally moved). With `omitTimes` the patch carries title/colorId/description only.
  (Also apply this rule to `rerouteMasterLinkedItemPush`.)
- Trash rows: routine instance → `pushRoutineInstanceCancellation`; standalone → existing trash
  branch of `pushExistingItemToGCal` (delete). Both stamp `lastPushedToGCalTs` so the row leaves
  the candidate set; a 404 is a skip that must **also** stamp (else it re-runs every sync).
- Keep pacing (`MISSED_PUSH_PACE_MS`), sequential execution and the `before` fence.

Tests (unit, `src/tests/missedPushSweep.test.ts`):
- done routine instance with instance id, no exception, `updatedTs > lastSyncedFromGCalTs`, no
  `lastPushedToGCalTs` → patched by instance id with ✓ title + `colorId '2'` and **no** `start/end`
  in the request body; `lastPushedToGCalTs` stamped.
- same row but routine has `modified` exception with `itemId` = row → body carries start/end.
- trashed routine instance → `status: 'cancelled'` patch by instance id; stamped.
- trashed standalone → `events.delete`; stamped.
- row written during the sync (`updatedTs >= before`) → not a candidate.
- row already pushed (`lastPushedToGCalTs > updatedTs`) → not a candidate.
- provider 404 on the instance → skip **and** stamp.
- existing legacy-`itemId` tests keep passing.

E2E (`e2e/calendar-missed-push-sweep.spec.ts`, new; template `calendar-relink-sweep.spec.ts`): seed a
routine with a linked master + generated items via existing dev seeding, set integration `suspended`,
mark two occurrences done and trash one in the UI (`gtd.flush()` after), set `active`, add/extend a
dev endpoint `POST /dev/calendar/simulate-missed-push-sweep` that runs `runMissedPushSweep` with a
recording stub provider and returns the recorded calls → assert 2 instance patches with `✓ ` +
`colorId '2'` and no `start`, 1 cancellation, and that the SyncIssuesPanel rows from Step 1 are gone
after the sweep (or after Retry).

# Step 3 — Inbound `modified` exceptions land on `done` rows, then re-assert ✓

Goal: Google moving/retitling an occurrence you already completed updates the GTD row's
time/title/GCal-owned fields (status untouched) and re-pushes the ✓/green so the moved instance is
marked.

Files: `api-server/src/routes/calendar.ts`.
- `resolveExceptionTarget` (:4719): tier 1 (`calendarInstanceEventId` match) accepts
  `status: {$in:['calendar','done']}`; tiers 2/3 stay `calendar`-only (they are date/instant
  heuristics — a done row must only be claimed by its own instance id). `ExceptionTarget.filter` must
  reflect the widened predicate.
- `applyModifiedExceptionToMatches` / `buildModifiedExceptionPatch`: never write `status`; keep the
  `updatedTs` guard. For matches with `status: 'done'`, after the write call
  `pushRoutineInstanceOverride` (import from `lib/calendarPushback.ts`; pass `sendUpdates: 'none'`)
  so ✓/green is re-applied to the moved instance. Guard against echo: the inbound apply stamps
  `lastSyncedFromGCalTs = ctx.now`; the re-push stamps `lastPushedToGCalTs` — confirm the next
  webhook's re-report of this instance is a no-op (`applyModifiedExceptionToOne` compares fields).
- `handleOrphanInsertDuplicate` (:5046): a same-routine `done` twin holding the instance id is now
  reachable through tier 1, so this branch is only hit for a same-routine `trash` twin; log at
  `debug` level (it fires every webhook for future-dated rows today) and bail as before.
- `isExceptionBeforeToday` unchanged.

Tests (unit, `src/tests/calendar.applyException.test.ts`, via `reconcileAndApplyRoutineExceptions`):
- done row with instance id + reported `modified` with new times → row time updated, status still
  `done`, one op recorded, provider `events.patch` called with ✓ title + colorId + new times.
- done row, reported `deleted` → see Step 4.
- `trash` row with the instance id + reported `modified` → **not** updated (still trash), no orphan
  created, no repeated warn at `warn` level.
- calendar row unchanged behaviour (existing tests).
- Second delivery of the same exception → zero ops (idempotent).

E2E (`e2e/calendar-done-row-moved-on-google.spec.ts`, new; reuse
`/dev/calendar/simulate-routine-exception-sync`): complete a routine occurrence in the UI, simulate a
Google move of that occurrence, reload → the done item shows the new time on `/done` (or item page),
and the recorded stub calls include the ✓ patch.

# Step 4 — Inbound `deleted` exceptions apply to `done` rows (per Q1)

Files: `api-server/src/routes/calendar.ts` `applyExceptionToItems` (:4666-4675).
- If Q1 = trash: the `deleted` branch writes via a filter widened to `status: {$in:['calendar','done']}`
  (tier 1 only, by instance id) → `status:'trash'`, `$unset calendarInstanceEventId`, op recorded.
  Trashing a done row must not fire an outbound cancellation for an instance Google already
  removed — the recorded op flows through `notifyChange`; either pass `suppressGCalPushback` for
  these ops (see `lib/applyOperation.ts:43` / `notifyChange` options) or rely on the 404-skip. Prefer
  suppress (no wasted call, no `syncFailed` noise).
- If Q1 = keep done: only `$unset calendarInstanceEventId` on the done row; no status change.
- `reconcileRevivedSkippedExceptions` (:5325): a revived date must revive **only** rows it trashed
  (status trash) — a done row trashed by this step and later un-cancelled on Google should come back
  as `calendar`, which matches today's revive semantics; add a test.

Tests (unit): done row + reported `deleted` → trashed (or unset), op recorded, no provider call;
calendar row → unchanged behaviour; revive after un-cancel. E2E: extend
`e2e/calendar-revive-skipped-routine-instance.spec.ts` or add a case: complete an occurrence, simulate
Google cancelling it, `/done` no longer lists it (Q1 = trash).

# Step 5 — Group C semantics (per Q2/Q3/Q4)

Files:
- `api-server/src/lib/calendarPushback.ts`
  - Q2 (cancel anyway): no past-occurrence skip on the server. Past and future occurrences are both
    cancelled on Google; the only difference is notification (below).
  - Q3: thread `sendUpdates` from `maybePushToGCal` (:94) into `pushRoutineInstanceCancellation`,
    `removeItemGCalPresence` and the standalone trash branch of `pushExistingItemToGCal`; provider
    `cancelRecurringInstance` gains `options.sendUpdates` → `patchInstanceById(…, sendUpdates)`;
    `deleteEvent` gains the same (check its signature). Absent `gcalMeta` → `'none'` as today, so
    sweep re-pushes and past-occurrence trashes stay silent, matching Google.
  - Q4: replace the blanket `if (!routine.active) return;` (:392) with "skip only when paused":
    `active === false` **and** the rrule carries no `UNTIL` (a pause caps the master via
    `pushRoutinePause`, but the local rrule is left unchanged; a split's capped base carries
    `UNTIL=` in its rrule — see `c63580e0…`, `extractUntilFromRrule`). Capped bases fall through
    to the existing `isBeyondUntilCap` guard and cancel by instance id. Verify the pause path in
    `src/tests/calendar.pushback.test.ts` still skips (existing tests) and add the capped-base case.
- Client (Q3): `client/src/components/itemEditor/sendUpdatesDialogLogic.ts` — fire when
  `before.status === 'calendar'`, `after.status === 'trash'`, attendees ≥1 (other than self), self is
  the organizer, **and the occurrence has not ended yet** (`timeEnd`, fallback `timeStart`, compared
  to now — Google is silent for past events, so no dialog then). Wire the trash gesture in
  `ItemEditorBody.tsx` (and the row-level trash action on `/calendar` if one exists) to
  `updateItemWithGcalMeta`. Unit test the gate (`sendUpdatesDialogLogic.test.ts`), including the
  past-occurrence and guest-not-organizer negatives.

Tests (unit): past organizer-owned trash (no `gcalMeta`) → cancelled with `sendUpdates:'none'`;
future organizer-owned trash with `gcalMeta.sendUpdates:'all'` → `events.patch` with
`sendUpdates:'all'`; standalone trash with `gcalMeta` → `events.delete` with `sendUpdates`;
attendee-less trash → unchanged; capped-base occurrence trash → cancelled by instance id, paused
routine → still skipped (Q4). E2E: trash a future organizer-owned routine occurrence in the editor →
SendUpdatesDialog appears; choose "Notify" → dev stub records `sendUpdates:'all'`; trash a past one →
no dialog, stub records `'none'`.

# Step 6 — Docs

The docs were aligned to the pre-fix behaviour on 2026-09-25 and state it as plain fact (no
forward-looking markers). Every statement below therefore becomes false once Steps 1–5 land and
must be rewritten in the same commit:

- `api-server/README.md` § Calendar Pushback — the "Suspended / revoked integrations" paragraph
  (skip → `scope_missing` failure with Reconnect); the trash rows of the effect table (`sendUpdates`
  now threaded, inactive-routine skip narrowed per Q4); § Missed-push sweep — the candidate list
  (instance-id query incl. `trash`) and the time-clobber paragraph (`omitTimes`); § `invalid_grant`
  escalation step 1; § Gotchas pushback bullet.
- `api-server/CLAUDE.md` § Calendar pushback — the silent-drop bullet (now the invariant: a push
  skipped for a non-active integration **is** a `scope_missing` failure), the `sendUpdates` default
  bullet, the sweep bullet, and the inbound-targeting bullet (tier 1 matches `calendar` + `done`).
- `docs/DATA_MODEL.md` § Routine exceptions (sweep `itemId` dependence; done rows now follow inbound
  moves / cancellations per Q1), § Done and trash markers on Google (cancellation semantics per
  Q2/Q3), § Pushback failures on the op and the `operations` schema note (skips now write markers).
- Root `CLAUDE.md` § Calendar Integration — the pushback-failures bullet.
- `docs/CALENDAR_ROUTINE_SYNC_TESTS.md` J5, J6 and open question 9; add a J case for the
  SendUpdatesDialog-on-trash gate (Q3) if none fits elsewhere.
- `api-server/src/types/entities.ts` — the `CalendarIntegrationInterface.status` doc comment
  (suspended/revoked → pushback records `scope_missing`).
- Copy reviewer memory files from the root `.claude/agent-memory/` into the tracked
  `api-server/.claude/agent-memory/` before committing (root dir is gitignored).

---

# Repair plan for the staging rows (run after Steps 1–4 are deployed to staging)

Order matters: B rows first (a ✓ re-push from the stale time would move Google back).

1. **B1 / B2 — fix times, which also pushes ✓ (integration is active now):** via MCP
   `gtd_update_item` (account `work`) — B1 `fdbda589-31e0-4ce3-b984-24ae4bb70796` → `timeStart
   2026-09-24T09:15:00+03:00`, `timeEnd 2026-09-24T09:25:00+03:00`; B2
   `c4eec141-007f-481f-897d-9a6fd97bb9eb` → `11:15:00+03:00` / `11:30:00+03:00`. Verify
   `lastPushedToGCalTs` stamped (mongosh) and the log line `overriding routine instance … status=done`.
   Alternatively skip this once Step 3 is deployed and instead nudge each Google instance (any
   Google-side edit re-delivers the move) — but the MCP patch is deterministic; prefer it.
2. **A1–A7 + the 7 other same-window rows:** Settings → the work calendar row → **Sync now** (runs
   the Step 2 sweep). Verify: each of the 18 rows gains `lastPushedToGCalTs`, and the
   `[gcal-pushback] missed-push sweep | … candidates=N` log shows N ≥ 16 (18 minus B1/B2 already
   stamped). Spot-check Google via the user (A1, A3, A6, A7).
3. **C1** is cancelled by the same sweep (trash row, past occurrence → `sendUpdates:'none'`, no
   dialog). Verify with the user that the 22 Sep 13:15 Team Weekly occurrence is gone from Google
   and that no cancellation email reached the 3 guests.
4. **D1** `22a587e4-fa0f-4bc0-a68f-6874c8756f5d`: if Q1 = trash, it is healed by the next sync only
   if Google re-reports the tombstone (`showDeleted: true`, but the instance is now past the sync
   cursor — likely **not** re-reported). Repair directly: `gtd_trash_item` via MCP; the outbound
   cancellation hits 404 (instance gone) and skips. Then confirm `calendarInstanceEventId` was freed
   (if not, `$unset` via mongosh + a recorded op, mirroring `updateItemsAndRecordOps`).
5. Post-repair audit (mongosh):
   `db.items.find({user, routineId:{$exists:true}, status:{$in:['done','trash']},
   updatedTs:{$gte:'2026-09-23T13:41:24Z',$lte:'2026-09-23T14:13:20Z'}, lastPushedToGCalTs:{$exists:false}})`
   must return 0 rows.

# Post-change checklist (per step)

API: `cd api-server && npm run lint:fix && npm run typecheck && npm run test` → `api-code-reviewer`.
Client (Step 5 only): `cd client && npm run generate-typed-css-modules && npm run lint:fix && npm run
typecheck && npm run test` → `client-code-reviewer`. E2E: `cd e2e && npm run lint:fix && npx playwright
test <changed specs>`. Lint warnings count as failures. Reviewer must return **Approved**. Then ask for
commit approval, commit with a ≤50-char subject + 72-col body, and after all steps: merge to
`staging`, deploy (`./scripts/deploy.sh api staging`, `gh` account `yuval-yssak`), run the repair plan,
then merge to `main`.
