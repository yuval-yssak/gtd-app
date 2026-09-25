# GTD App — Data Model

## Overview

This app implements the [Getting Things Done](https://gettingthingsdone.com/) methodology. Work flows through four phases:

1. **Collect** — Capture anything on your mind into the inbox without judgement.
2. **Clarify / Organize** — Process inbox items one by one: trash them, complete them immediately, schedule them, delegate them, or turn them into actionable next steps with metadata attached.
3. **Review** — Scan all buckets regularly (quick scan several times a day; deep weekly review) to keep the system current.
4. **Do** — Filter the next-action list by available energy, time, and work context to find the right task for right now.

---

## Item Statuses

Every item has exactly one status at a time.

| Status | Meaning |
|---|---|
| `inbox` | Freshly captured; not yet clarified |
| `nextAction` | Actionable; do it as soon as possible |
| `calendar` | Can only happen in a specific time window (meeting, appointment) |
| `waitingFor` | Delegated/blocked; waiting on another person — or on an external event — to act |
| `somedayMaybe` | Parked for later review; may carry deferral dates but no schedule or context |
| `done` | Completed |
| `trash` | Discarded |

### Tickler pattern (`ignoreBefore`)

A `nextAction`, `waitingFor`, or `somedayMaybe` item can carry an `ignoreBefore` date. The item is hidden from all active lists (`/next-actions`, `/waiting-for`, `/someday`) until that date arrives, then surfaces automatically. This is the GTD "tickler file" — a way to defer something without cluttering today's view. While snoozed, the item stays reachable in exactly one place — the `/tickler` page, which lists all three statuses grouped by date and offers "release now". Global search deliberately still matches snoozed items: looking one up by name is an explicit act, not list clutter.

> `ignoreBefore` is a separate field from the calendar `timeStart`/`timeEnd` pair to keep their semantics unambiguous.

### Item briefs

A **brief** is a one-line, review-oriented condensation of an item's title + notes — *what the commitment is and why it is still open*, never logistics. The Weekly Review card shows it in place of the (long) notes preview.

It lives in its own synced entity, `itemBrief` (collection `itemBriefs`), **not** as a field on `items`, with `_id === item._id` (one-to-one). Every op is a full snapshot replaced under last-write-wins on `updatedTs`, so a server-generated brief written onto the item would beat any offline edit a device has not pushed yet, and the sweeper selects exactly the items being edited (hash mismatch is the trigger). A sidecar has its own LWW anchor, so an item edit and a brief write never contend.

- **`sourceHash`** — `briefSourceHash(title, notes)` (cyrb53 over `title + '\n' + notes`, mirrored in `api-server/src/lib/briefSource.ts` and `client/src/lib/briefSource.ts` with a parity test) at generation/authoring time. A brief is shown only while it matches the item's current hash; a stale one degrades to the notes preview instead of showing a lie.
- **`origin`** — `model` (generated), `skipped` (notes empty or under 160 chars after trim; `text: null`, written without a model call so the sweeper does not reselect the item), `user` (typed in the editor), `agent` (written via `PUT /v1/items/:id/brief` / MCP `gtd_set_brief`). `model` and `skipped` rows are **server-written only** (`lib/brief/briefWriter.ts`, stamped `deviceId: 'server:brief-ondemand' | 'server:brief-inline' | 'api:<tokenId>'`); the public batch surface rejects them, and every generation write is a compare-and-set on `sourceHash` so a result never lands on content it does not describe.
- **Pinned briefs** — `user` and `agent` origins are never overwritten by the sweeper, and the UI keeps showing them after the notes change with a "notes changed since" marker (explicit Regenerate overrides).
- **Derived state** (`briefState(item, brief)`): `none` (no row, or a non-pinned row whose hash no longer matches), `declined` (hash matches but `text` is `null` — the server decided against a brief for exactly this text; the UI says which reason from `origin` rather than rendering an empty field, since a silent blank is indistinguishable from a broken or pending feature), `fresh` (hash matches, text present), `pinnedStale` (hash mismatch on a pinned origin). A `declined` decision lapses to `none` once the title/notes move on, so the next sweep reconsiders it.
- **Targeting scope** — briefs are generated for OPEN items only (`inbox`, `nextAction`, `calendar`, `waitingFor`, `somedayMaybe`). A `done` / `trash` item is never reviewed, so a brief for one can never be read; the on-demand endpoint refuses with `409 brief_not_applicable` and `force` does not override it. This reversed an earlier "all statuses" decision on 2026-09-21 — see `docs/plans/item-brief.md` § Targeting scope.
- **Selection marker** — `items.briefStale` (server-owned, see [`items`](#items)) is what makes the sweep a bounded indexed lookup rather than a walk of every item. It is a selection hint only: the compare-and-set in `lib/brief/briefWriter.ts` remains the authority on staleness and re-hashes title + notes for real.
- **Lifecycle** — item hard-delete and cross-account reassign drop the brief with a recorded `itemBrief` delete op (`deviceId: 'server:brief-cascade'`); it never moves with the item. Trash / done KEEP the briefs they already have — they are paid for, and an item revived from trash or reopened from done finds its brief either still fresh or correctly stale. Nothing deletes them.

---

## Work Contexts

A **work context** is a condition that must be true for a task to be doable — e.g.:

- `near a phone`
- `at work`
- `with family`
- `focused at laptop`
- `while at the mall`

Contexts are named entities (their own collection), so they can be renamed and merged across all items at once. Each `nextAction` item carries zero or more context refs (`workContextIds`). During the **Do** phase, the list is filtered to contexts that match the user's current situation.

---

## People

A **person** is a named contact referenced by items. Uses:

- `peopleIds` on any item — to associate collaborators or stakeholders
- `waitingForPersonId` on `waitingFor` items — the specific person being waited on (optional; a `waitingFor` item may be blocked on an external event rather than a person)
- `externalCalendarId` — link to their Google Calendar for scheduling

| Field | Purpose |
|---|---|
| `name` | Display name |
| `email` | Contact / future notification support |
| `phone` | Useful for "near a phone" context filtering |
| `externalCalendarId` | Google Calendar "other person's calendar" ID |
| `notes` | Free-form personal notes |

---

## Routines (Recurring Tasks)

A **routine** is a template that generates items on a schedule. All routines use an [RFC 5545 RRULE](https://datatracker.ietf.org/doc/html/rfc5545#section-3.3.10) string (e.g. `FREQ=WEEKLY;BYDAY=MO`) to define their recurrence.

### `routineType: 'nextAction'`

Generates `nextAction` items. The next instance is created only after the previous one is marked done or trashed. DTSTART is set dynamically to the completion date when computing the next occurrence. Good for habits and maintenance tasks where exact timing doesn't matter (e.g. "review inbox", "water plants").

### `routineType: 'calendar'`

Generates `calendar` items on a fixed schedule. Uses `calendarItemTemplate` (time of day + duration) to set `timeStart`/`timeEnd` on generated items. DTSTART is `startDate ?? createdTs` (fixed absolute schedule — user-editable via `startDate`). Good for standing meetings and appointments.

### `startDate` (both routine types)

Optional ISO date (YYYY-MM-DD) that anchors the rrule schedule. Falls back to `createdTs` when unset. For calendar routines, `seriesStartDate` snaps it forward to the first BYDAY/BYMONTHDAY match. For nextAction routines, no items are generated with an occurrence date before `startDate` — a future `startDate` delays the first item until a boot-tick materializes it on the app's next sync after the startDate passes.

### Active / Paused lifecycle

The `active` flag controls whether a routine continues to generate items. The invariants per routine type:

| Routine type | Active | Paused (`active=false`) |
|---|---|---|
| `nextAction` | At most one open item (the next pending occurrence). Generate-on-dispose: completing/trashing the current item produces the next one. | Zero open items. |
| `calendar` | Unbounded (2-month horizon of future calendar slots). | Zero future open items. |

"Open" = status is neither `done` nor `trash`. When a user pauses a routine (app-side via the Pause icon in the Routines list):

- All **future** open items tied to the routine are trashed. Past-due open items are left alone — they're the user's backlog, not part of the forward-looking invariant.
- For calendar routines linked to Google Calendar: the GCal master series is capped with `UNTIL=<yesterday>` via `events.patch`. `calendarEventId` is stable; past occurrences remain intact on Google's side.

A paused routine is **resumed** by opening its edit dialog, setting a new `startDate`, and saving. The save flips `active=true`, the server pushback clears the GCal master's pause-era UNTIL, and future items regenerate.

### Calendar series linking

A routine can be linked to a Google Calendar recurring event series via `calendarEventId` + `calendarIntegrationId` + `calendarSyncConfigId`. The app supports both directions:

- **App-owned**: the app creates the RRULE and pushes a new recurring series to Google Calendar.
- **Import**: the user attaches an existing Google Calendar recurring series to the routine; the app follows Google's schedule.

### Routine exceptions

When a user trashes a future calendar item generated by a routine, its date is recorded as a `'skipped'` exception in `routineExceptions`. When Google Calendar moves a single occurrence, it's recorded as `'modified'` with the new times. The generator skips or adjusts these dates accordingly.

`itemId` on a `'modified'` exception is written **only by the client** on an in-app move (`recordRoutineInstanceModification`); inbound exceptions from Google never carry it. The missed-push sweep uses that `itemId` to find routine occurrences worth re-pushing and then keeps only `calendar`/`done` rows, so a trashed occurrence (moved or not) and a completed one that was never moved in-app are not sweep candidates (see `api-server/README.md` § Missed-push sweep).

Inbound exceptions are matched to items by `calendarInstanceEventId` (tier 1), then by original date / instant (tiers 2–3), in every tier only against `status: 'calendar'` rows. A Google move or cancellation of an occurrence the user already marked `done` therefore leaves the done row untouched: the move's orphan insert collides with the done row's instance id and bails when the row belongs to the same routine (a done twin from a *different* routine is demoted and a fresh live row inserted), and the cancellation updates zero rows. Because `getExceptions` reports instances from `max(syncCursor, now − 30 days)` onward, a past occurrence missed this way is not re-reported later.

Each generated item instance carries `routineId` pointing back to its parent routine, and inherits the routine's `template` fields (`workContextIds`, `peopleIds`, `energy`, `time`, `focus`, `urgent`, `notes`).

---

## Sync Architecture

The app is designed to work **100% offline**. All mutations are recorded as operations and replayed against the server when connectivity is restored.

### Operations log (server-side)

Every change to any entity (`item`, `routine`, `person`, `workContext`, `reviewInbox`, `itemBrief`) is recorded as an `OperationInterface` document on the server. Each operation stores:

- `deviceId` — which device originated the change
- `ts` — when the change was made on the device (ISO datetime)
- `entityType` + `entityId` — what was changed
- `opType` — `create`, `update`, or `delete`
- `snapshot` — the **full entity state** at the time of the operation (or `null` for deletes)

Storing full snapshots (not diffs) keeps conflict resolution simple: for any entity, the operation with the latest `ts` wins.

### Conflict resolution

All entities carry `updatedTs`. When two devices make conflicting changes to the same entity while offline, the server applies last-write-wins: whichever operation has the later `ts` is the authoritative state.

### Device sync state

Each device registers itself in `DeviceSyncStateInterface` with a stable UUID generated on first launch. The server tracks:

- `lastSyncedTs` — the most recent operation this device has pulled
- `lastSeenTs` — the most recent operation this device has pushed

**Purge rule**: operations older than `min(lastSyncedTs)` across all of a user's devices can be safely deleted. This prevents unbounded log growth while guaranteeing every device can always catch up.

### Client-side sync queue (IndexedDB)

When offline, the client queues mutations as `SyncOperation` records in IndexedDB. Each record stores `entityType`, `entityId`, `opType`, `queuedAt`, and the full entity `snapshot`. When connectivity is restored, the queue is flushed to the server in `queuedAt` order.

---

## Calendar Integration

Calendar integration is modelled via two entities:

- **`CalendarIntegrationInterface`** — stores OAuth credentials for a connected Google Calendar account.
- **`CalendarSyncConfigInterface`** — per-calendar sync state within an integration (one OAuth account can sync multiple calendars).

### Item-level sync
A `calendar` item can be linked to a specific Google Calendar event via `calendarEventId` + `calendarIntegrationId` + `calendarSyncConfigId`. Changes flow bidirectionally: updates in the app push to Google; webhook or poll updates from Google are reflected back on the item.

### Sync anchors and echo avoidance
Items and routines carry two anchors:

- `lastPushedToGCalTs` — the most recent push to Google. A webhook-triggered pull that finds a change inside the echo window is recognized as the app's own write and skipped.
- `lastSyncedFromGCalTs` — `event.updated` of the most recent inbound Google payload applied. Inbound conflict resolution compares against this, not `updatedTs`, so local-only writes (trash-on-disconnect, no-op exception churn) cannot lock Google out of reasserting state.

Together they define a **missed push**: `updatedTs > max(lastPushedToGCalTs, lastSyncedFromGCalTs)` means a local edit never reached Google. The "Sync now" sweep re-pushes such rows; an anchor-less row is never re-pushed because nothing proves which side is newer.

### Done and trash markers on Google
Completing a linked item does **not** delete the event: Google keeps it with a `✓ ` title prefix and a sage colour (the stored title stays clean). For a routine occurrence this is a per-instance override keyed by `calendarInstanceEventId`; the series master is never touched. Trashing deletes a standalone event or cancels the single occurrence (skipped when the routine is inactive or the occurrence lies beyond the master's `UNTIL`). Neither trash path reads the op's `gcalMeta` (the done paths do forward it): an occurrence cancellation always sends `sendUpdates: 'none'`, a standalone delete sends no `sendUpdates` parameter (Google's default applies), and no dialog asks. While the integration is `suspended`/`revoked` all of these pushes are dropped without a failure marker — see `api-server/README.md` § Calendar Pushback.

### Integration auth status
`calendarIntegrations.status` is `active` (absent counts as active) → `suspended` on the first `invalid_grant` (the client-driven sync endpoint and other user-driven routes still call Google; webhook deliveries, the renew cron and outbound pushback skip) → `revoked` on the next `invalid_grant` seen at least 24 h after `suspendedAt` (everything skips, sync endpoint returns 410; any Google call outside pushback — the sync endpoint, calendar listing, routine linking — can trigger it). Reconnecting resets it to `active`; dropped pushes are replayed only by the outbound backfill + missed-push sweep inside `POST /calendar/integrations/:id/sync`, which the client runs on its next sync cycle.

### Pushback failures on the op
A push whose GCal side-effect throws is recorded on the originating `operations` row (`syncFailed`, `failureReason`, `failureDetail`, `failedTs`) and listed by `GET /sync/issues` for the SyncIssuesPanel. `transient_exhausted`, `scope_missing`, `edit_conflict` and `calendar_missing` rows offer Retry and Dismiss; `terminal` and `entity_missing` rows offer Dismiss only (Dismiss deletes the op row). The panel has no Reconnect button — for `scope_missing` the user reconnects in Settings first, then retries.

### Routine-level sync
A routine can be linked to a Google Calendar recurring event series (see [Routines](#routines-recurring-tasks) above).

**Tokens are encrypted at rest.** Access tokens are short-lived; the server uses `refreshToken` to obtain a new one when `tokenExpiry` is in the past.

---

## Schema Reference

### `items`

```typescript
interface ItemInterface {
    _id?: string;                    // client-generated UUID (MongoDB _id)
    user: string;                    // Better Auth user ID
    status: 'inbox' | 'nextAction' | 'calendar' | 'waitingFor' | 'somedayMaybe' | 'done' | 'trash';
    title: string;
    createdTs: string;               // ISO datetime
    updatedTs: string;               // ISO datetime — last-write-wins anchor
    workContextIds?: string[];       // refs to workContexts._id
    peopleIds?: string[];            // refs to people._id
    waitingForPersonId?: string;     // ref to people._id (waitingFor items)
    expectedBy?: string;             // ISO date — deadline
    ignoreBefore?: string;           // ISO date — tickler hide-until date
    timeStart?: string;              // ISO datetime — calendar items only; YYYY-MM-DD when allDay
    timeEnd?: string;                // ISO datetime — calendar items only; exclusive YYYY-MM-DD when allDay
    allDay?: boolean;
    routineId?: string;              // ref to routines._id
    energy?: 'low' | 'medium' | 'high';
    time?: number;                   // estimated minutes
    focus?: boolean;
    urgent?: boolean;
    notes?: string;                  // freeform markdown
    briefStale?: boolean;            // server-owned brief-sweep selection marker (see below)

    // ── Google Calendar linkage ──
    calendarEventId?: string;        // Google event id — standalone items only; routine occurrences leave it unset
    calendarIntegrationId?: string;  // ref to calendarIntegrations._id
    calendarSyncConfigId?: string;   // ref to calendarSyncConfigs._id
    calendarInstanceEventId?: string;// routine occurrences: `<masterId>_<YYYYMMDDTHHMMSSZ>` (all-day series: `<masterId>_<YYYYMMDD>`) — what instance pushes patch
    lastPushedToGCalTs?: string;     // ISO datetime — outbound anchor (echo detection, missed-push test)
    lastSyncedFromGCalTs?: string;   // ISO datetime — inbound anchor: event.updated of the last applied payload (routine-exception paths stamp the sync's `now` instead)
    lastSyncedNotes?: string;        // notes value at the last in/outbound sync — gates description LWW
    cancelledByGCal?: boolean;       // server-set when an inbound cancellation trashed the row
    // Disconnect-with-keep markers: prior link ids so a reconnect can relink by strong key
    lastKnownCalendarEventId?: string;
    lastKnownCalendarIntegrationId?: string;
    lastKnownCalendarSyncConfigId?: string;
    lastKnownCalendarAccountEmail?: string;
    // GCal-owned, server-overwritten on every inbound pull (read-only in-app except attendees/RSVP)
    organizer?: GCalPerson;
    creator?: GCalPerson;
    attendees?: GCalAttendee[];
    responseStatus?: GCalResponseStatus;
    eventType?: GCalEventType;       // 'fromGmail' events are read-only via the API — pushback skips them
    meetingLink?: string;
    location?: string;
    htmlLink?: string;

    // Public-API only
    externalId?: string;             // caller dedupe key, sparse-unique on (user, externalId)
    contentHash?: string;            // sha256(title\nnotes) at create — 24h content dedupe, never returned
}
```

MongoDB indexes: `{ user }`, `{ user, status }`, `{ user, expectedBy }`, `{ user, timeStart }`, `{ user, updatedTs }`, `brief_stale_targets` = `{ user, briefStale, status }` partial on `briefStale: true`, `uniq_calendar_item_per_event` = `{ user, calendarEventId }` unique partial on `status: 'calendar'` **and** a string `calendarEventId` (done/trash rows keep the id for revive/relink), `{ user, calendarInstanceEventId }` unique partial on presence only — **not** status-scoped, so a done occurrence, or one the user trashed (in-app, or via `POST /v1/items/:id/trash` / MCP `gtd_trash_item`), still owns its instance id — only sync-engine trash paths (routine delete, regeneration, inbound cancellation, dead-twin demotion) `$unset` it — and an orphan insert for the same instance raises E11000.

**`briefStale`** is server-owned and never sent by a client (`ItemsDAO` re-stamps it from the document on every write; `stripBriefStale` drops whatever arrives). It marks items whose `title`, `notes` or `status` may have moved since their `itemBriefs` row, which is what lets the brief sweep select by index instead of walking and re-hashing the whole collection.

It is **tri-state**: `true` = needs a sweep, `false` = swept and settled, absent = written before the field existed. `false` and absent are deliberately distinct — the boot backfill claims exactly the absent ones, so collapsing them would have it re-mark the whole collection on every Cloud Run cold start. The index is partial on `briefStale: true`, so settled rows cost a boolean on disk and nothing in the index.

It is a **selection hint, not an authority** — `lib/brief/briefWriter.ts`'s compare-and-set re-reads the item and hashes for real, and settling is guarded on the item's content so a write racing the sweep cannot have its mark erased. `presentItem`'s allowlist hides it from the public API; the op schema accepts it only to stay a strict superset of the interface (a narrower schema would 400 the whole `/sync/push` batch). See `lib/brief/briefStaleMarker.ts`.

---

### `itemBriefs`

One-to-one sidecar of `items` (see [Item briefs](#item-briefs)). Its own LWW anchor, separate from the item's.

```typescript
type BriefOrigin = 'model' | 'user' | 'agent' | 'skipped';

interface ItemBriefInterface {
    _id?: string;            // === item._id
    user: string;
    itemId: string;          // same value as _id, kept for readable queries and op-log rows
    text: string | null;     // null only when origin === 'skipped'
    origin: BriefOrigin;
    sourceHash: string;      // briefSourceHash(item.title, item.notes) when produced
    model?: string;          // model id when origin === 'model'
    generatedTs: string;     // ISO datetime the text was produced
    createdTs: string;
    updatedTs: string;       // LWW anchor for THIS entity only
}
```

MongoDB indexes: `{ user }`, `{ user, sourceHash }` (`_id` is the implicit unique key). Op schema `schemas/operations/itemBrief.ts` is strict and a superset of the interface; it also pins `_id === itemId`.

### `briefBatches` / `briefBatchRequests` (server-only)

Bookkeeping for the Message Batches sweep (`lib/brief/briefBatch.ts`, `POST /maintenance/briefs/sweep`). Neither is a synced entity and neither reaches a client.

```typescript
interface BriefBatchInterface {
    _id: string;                  // the Anthropic batch id (msgbatch_…)
    createdTs: string;
    submittedCount: number;
    status: 'processing' | 'harvested' | 'expired' | 'failed';
    harvestedTs?: string;
    resultCounts?: { succeeded; errored; canceled; expired; discardedStale; pinned; written };
    expiresAt: Date;              // BSON Date — TTL anchor, createdTs + 90 d
}

interface BriefBatchRequestInterface {
    _id: string;                  // the request's custom_id (opaque 32-hex token)
    batchId: string;
    user: string;
    itemId: string;
    sourceHash: string;           // the compare-and-set anchor at harvest
    createdTs: string;
    expiresAt: Date;              // BSON Date — TTL anchor, createdTs + 48 h
}
```

A `processing` batch row is the "one batch in flight" guard. Request rows normally exist only while their batch is processing (`deleteByBatch` runs on harvest/expiry/failure) — Anthropic caps `custom_id` at 64 chars of `[A-Za-z0-9_-]`, so the (user, item, hash) identity cannot be encoded in it.

Indexes: `briefBatches { status }` + `{ expiresAt }` TTL, `briefBatchRequests { batchId }`, `{ user }` + `{ expiresAt }` TTL. `expiresAt` is a **BSON `Date`**, not an ISO string — Mongo's TTL monitor only reaps real Dates, so a string field would index fine and never fire (the ISO-string `expiresTs` TTL indexes on `apiTokens` / `oauthRefreshTokens` / `oauthAuthCodes` are silent no-ops for exactly this reason; those DAOs enforce expiry at read time instead — do not copy them for GC). Requests expire 48 h after creation (outliving the 26 h batch ceiling), batch rows after 90 d (a bounded operator audit trail). The TTL is a backstop for rows stranded by a crash between the paired writes, not the normal cleanup path.

---

### `routines`

```typescript
interface RoutineItemTemplate {
    workContextIds?: string[];
    peopleIds?: string[];
    energy?: 'low' | 'medium' | 'high';
    time?: number;                   // estimated minutes
    focus?: boolean;
    urgent?: boolean;
    notes?: string;
}

interface RoutineInterface {
    _id: string;
    user: string;
    title: string;
    routineType: 'nextAction' | 'calendar';
    rrule: string;                   // RFC 5545 RRULE (required for all routines)
    recurrenceAnchor?: 'floating' | 'fixed'; // nextAction only — how rrule is written, not a second computation path
    calendarEventId?: string;        // Google Calendar recurring event series ID (BARE id, even for split tails)
    calendarRebasedEventId?: string; // raw `<bareId>_R<anchor>` id when this routine is a "this and following" split tail
    splitFromRoutineId?: string;     // set on a split tail — points back to the head routine
    calendarIntegrationId?: string;  // ref to calendarIntegrations._id
    calendarSyncConfigId?: string;   // ref to calendarSyncConfigs._id
    lastPushedToGCalTs?: string;     // ISO datetime — outbound anchor
    lastSyncedFromGCalTs?: string;   // ISO datetime — inbound anchor for rrule/title/schedule (see Sync anchors)
    lastSyncedNotes?: string;
    lastKnownCalendarEventId?: string;       // disconnect-with-keep markers — see items
    lastKnownCalendarIntegrationId?: string;
    lastKnownCalendarSyncConfigId?: string;
    lastKnownCalendarAccountEmail?: string;
    organizer?: GCalPerson;          // GCal-owned master fields, mirrored onto generated items
    creator?: GCalPerson;
    attendees?: GCalAttendee[];
    responseStatus?: GCalResponseStatus;
    eventType?: GCalEventType;
    meetingLink?: string;
    location?: string;
    htmlLink?: string;
    template: RoutineItemTemplate;   // fields copied onto generated items
    active: boolean;                 // paused when false — see Active/Paused lifecycle above
    retiredByGCal?: boolean;         // deactivated because Google cancelled the series; heal endpoints never resurrect
    createdTs: string;
    updatedTs: string;
    startDate?: string;              // ISO date — anchors the rrule schedule; falls back to createdTs
    calendarItemTemplate?: {         // present when routineType === 'calendar'
        allDay?: boolean;            // when true, timeOfDay/duration are ignored
        timeOfDay?: string;          // HH:MM (24h) — start time; required when !allDay
        duration?: number;           // minutes; required when !allDay
    };
    lastGeneratedDate?: string;      // ISO date — most recent generated item's date
    routineExceptions?: Array<{      // overridden/deleted rrule occurrences
        date: string;                // ISO date of original occurrence
        type: 'skipped' | 'modified';
        itemId?: string;             // client-written on an in-app move only — never by inbound sync
        newTimeStart?: string;       // ISO datetime (modified only)
        newTimeEnd?: string;
        title?: string;              // per-instance overrides, present only when they differ from the master
        notes?: string;
        organizer?: GCalPerson;
        creator?: GCalPerson;
        attendees?: GCalAttendee[];
        responseStatus?: GCalResponseStatus;
        eventType?: GCalEventType;
        meetingLink?: string;
        location?: string;
        htmlLink?: string;
    }>;
}
```

**Deprecated fields** (present in old data, not used in new code):
- `triggerMode: 'afterCompletion' | 'fixedSchedule'` — replaced by `routineType`
- `afterCompletionDelayDays: number` — replaced by `rrule`

---

### `people`

```typescript
interface PersonInterface {
    _id: string;
    user: string;
    name: string;
    email?: string;
    phone?: string;
    externalCalendarId?: string;
    notes?: string;
    createdTs: string;
    updatedTs: string;
}
```

---

### `workContexts`

```typescript
interface WorkContextInterface {
    _id: string;
    user: string;
    name: string;
    createdTs: string;
    updatedTs: string;
}
```

---

### `operations`

```typescript
interface OperationInterface {
    _id: string;                     // server-generated UUID
    user: string;
    deviceId: string;
    ts: string;                      // ISO datetime — stamped by the server at insert time (op identity), not the device clock
    entityType: 'item' | 'routine' | 'person' | 'workContext' | 'reviewInbox' | 'itemBrief';
    entityId: string;
    opType: 'create' | 'update' | 'delete' | 'rsvp';
    snapshot: ItemInterface | RoutineInterface | PersonInterface | WorkContextInterface | ReviewInboxInterface | ItemBriefInterface | null;
    rsvp?: RsvpOpPayload;            // opType === 'rsvp' only (snapshot is null)

    // ── GCal-coupled sidecars (persisted with the op) ──
    gcalMeta?: { sendUpdates: 'all' | 'none' }; // client-written SendUpdatesDialog choice; absent ⇒ creates/updates send 'none'
    detachedCalendar?: ItemInterface; // server-hydrated by hydrateCalendarDetachSnapshots (before applyEntityOp): the pre-update row of a calendar item moving to an active
                                      // non-calendar status — the client strips link fields off the new snapshot, so this is what pushback deletes by

    // ── Server-written outcome markers ──
    syncFailed?: boolean;            // GCal side-effect threw (no retry loop in pushback), or target row missing at apply — listed by GET /sync/issues
    failureReason?: 'transient_exhausted' | 'scope_missing' | 'calendar_missing' | 'edit_conflict' | 'terminal' | 'entity_missing';
    failureDetail?: string;          // ≤ 200 chars
    failedTs?: string;
    notApplied?: boolean;            // target row no longer existed at apply time; excluded from /sync/pull
}
```

MongoDB indexes: `{ user, ts }`, `{ user, entityType, entityId, ts }`

The outcome markers are written when an op's GCal side-effect throws (a Google error or a failed config/timezone lookup inside the push), or with `failureReason: 'entity_missing'` plus `notApplied` when `applyEntityOp` finds no target row. A push skipped because the integration is `suspended`/`revoked` writes none of them — the op looks healthy and the only trace is the `skipping <status> integration` log line.

---

### `deviceSyncState`

```typescript
interface DeviceSyncStateInterface {
    _id: string;        // stable device UUID (client-generated on first launch)
    user: string;
    lastSyncedTs: string;
    lastSeenTs: string;
    name?: string;      // user-given label, e.g. "iPhone", "Work laptop"
}
```

---

### `calendarIntegrations`

```typescript
interface CalendarIntegrationInterface {
    _id: string;
    user: string;
    provider: 'google';
    accessToken: string;   // encrypted at rest (AES-256-GCM)
    refreshToken: string;  // encrypted at rest
    tokenExpiry: string;   // ISO datetime
    calendarId?: string;   // DEPRECATED — per-calendar state lives in calendarSyncConfigs; legacy rows only
    lastSyncedTs?: string; // ISO datetime of last successful pull
    accountEmail?: string; // lowercased Google account email — decides same- vs different-account reconnect
    grantedScopes?: string[]; // scopes Google actually granted; absent on legacy rows ⇒ permissive
    // invalid_grant escalation (lib/calendarAuthEscalation.ts) — absent status ⇒ 'active'
    status?: 'active' | 'suspended' | 'revoked';
    suspendedAt?: string;  // first invalid_grant; user-driven sync still tries, webhook/cron/pushback skip
    revokedAt?: string;    // first invalid_grant seen ≥ 24 h after suspendedAt; everything skips, sync endpoint returns 410
    lastAuthErrorAt?: string;
    createdTs: string;
    updatedTs: string;
}
```

---

### `calendarSyncConfigs`

Per-calendar sync state within an integration. One OAuth account (integration) can sync multiple Google Calendars.

```typescript
interface CalendarSyncConfigInterface {
    _id: string;
    integrationId: string;     // ref to calendarIntegrations._id
    user: string;
    calendarId: string;        // Google Calendar ID (e.g. 'primary')
    displayName?: string;      // human-readable name from Google
    isDefault: boolean;        // new app-created items go to this calendar
    enabled: boolean;          // user can pause sync per calendar
    lastSyncedTs?: string;     // ISO datetime of last pull for this calendar
    syncToken?: string;        // Google incremental sync token
    webhookChannelId?: string; // UUID for Google push notification channel
    webhookResourceId?: string;// Google's resource ID for the active watch
    webhookExpiry?: string;    // ISO datetime — channel expiry
    timeZone?: string;         // calendar's IANA zone from Google; refreshed by every sync, passed to outbound pushes
    createdTs: string;
    updatedTs: string;
}
```

MongoDB indexes: `{ user }`, `{ integrationId, calendarId }` (unique), `{ webhookChannelId }`

---

### `pushSubscriptions`

Web Push notification endpoints, one per device per user.

```typescript
interface PushSubscriptionRecord {
    _id: string;               // deviceId — upsert keeps one per device
    user: string;
    endpoint: string;          // Web Push endpoint URL
    keys: { p256dh: string; auth: string };
    updatedTs: string;
}
```
