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
- **Derived state** (`briefState(item, brief)`): `none` (no row, skipped row, or `model` row whose hash no longer matches), `fresh` (hash matches), `pinnedStale` (hash mismatch on a pinned origin).
- **Lifecycle** — item hard-delete and cross-account reassign drop the brief with a recorded `itemBrief` delete op (`deviceId: 'server:brief-cascade'`); it never moves with the item. Trash / done keep their briefs.

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

### Echo avoidance
Items and routines carry `lastPushedToGCalTs` — the timestamp of the most recent push to Google Calendar. When a webhook-triggered pull finds a change with a matching timestamp, it's recognized as the app's own echo and skipped.

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
    status: 'inbox' | 'nextAction' | 'calendar' | 'waitingFor' | 'done' | 'trash';
    title: string;
    createdTs: string;               // ISO datetime
    updatedTs: string;               // ISO datetime — last-write-wins anchor
    workContextIds?: string[];       // refs to workContexts._id
    peopleIds?: string[];            // refs to people._id
    waitingForPersonId?: string;     // ref to people._id (waitingFor items)
    expectedBy?: string;             // ISO date — deadline
    ignoreBefore?: string;           // ISO date — tickler hide-until date
    timeStart?: string;              // ISO datetime — calendar items only
    timeEnd?: string;                // ISO datetime — calendar items only
    calendarEventId?: string;        // Google Calendar event ID
    calendarIntegrationId?: string;  // ref to calendarIntegrations._id
    calendarSyncConfigId?: string;   // ref to calendarSyncConfigs._id
    lastPushedToGCalTs?: string;     // ISO datetime — echo detection
    routineId?: string;              // ref to routines._id
    energy?: 'low' | 'medium' | 'high';
    time?: number;                   // estimated minutes
    focus?: boolean;
    urgent?: boolean;
    notes?: string;                  // freeform markdown
}
```

MongoDB indexes: `{ user }`, `{ user, status }`, `{ user, expectedBy }`, `{ user, timeStart }`, `{ user, updatedTs }`

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
    calendarEventId?: string;        // Google Calendar recurring event series ID
    calendarIntegrationId?: string;  // ref to calendarIntegrations._id
    calendarSyncConfigId?: string;   // ref to calendarSyncConfigs._id
    lastPushedToGCalTs?: string;     // ISO datetime — echo detection
    template: RoutineItemTemplate;   // fields copied onto generated items
    active: boolean;                 // paused when false — see Active/Paused lifecycle above
    createdTs: string;
    updatedTs: string;
    startDate?: string;              // ISO date — anchors the rrule schedule; falls back to createdTs
    calendarItemTemplate?: {         // present when routineType === 'calendar'
        timeOfDay: string;           // HH:MM (24h) — start time
        duration: number;            // minutes
    };
    lastGeneratedDate?: string;      // ISO date — most recent generated item's date
    routineExceptions?: Array<{      // overridden/deleted rrule occurrences
        date: string;                // ISO date of original occurrence
        type: 'skipped' | 'modified';
        itemId?: string;
        newTimeStart?: string;       // ISO datetime (modified only)
        newTimeEnd?: string;
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
    ts: string;                      // ISO datetime — when the change was made on device
    entityType: 'item' | 'routine' | 'person' | 'workContext';
    entityId: string;
    opType: 'create' | 'update' | 'delete';
    snapshot: ItemInterface | RoutineInterface | PersonInterface | WorkContextInterface | null;
}
```

MongoDB indexes: `{ user, ts }`, `{ user, entityType, entityId, ts }`

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
    calendarId: string;    // Google Calendar ID to sync against
    lastSyncedTs?: string; // ISO datetime of last successful pull
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
