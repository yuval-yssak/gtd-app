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
| `waitingFor` | Delegated; waiting for another person to act |
| `done` | Completed |
| `trash` | Discarded |

### Tickler pattern (`ignoreBefore`)

A `nextAction` or `waitingFor` item can carry an `ignoreBefore` date. The item is hidden from all active lists until that date arrives, then surfaces automatically. This is the GTD "tickler file" — a way to defer something without cluttering today's view.

> `ignoreBefore` is a separate field from the calendar `timeStart`/`timeEnd` pair to keep their semantics unambiguous.

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
- `waitingForPersonId` on `waitingFor` items — the specific person being waited on
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

A **routine** is a template that generates `nextAction` items on a schedule. Two trigger modes:

### `afterCompletion`
The next instance is created only after the previous one is marked done, delayed by `afterCompletionDelayDays`. Good for habits and maintenance tasks where exact timing doesn't matter (e.g. "review inbox", "water plants").

### `fixedSchedule`
The next instance is created on a calendar schedule regardless of whether the previous one was completed. The schedule is expressed as an [RFC 5545 RRULE](https://datatracker.ietf.org/doc/html/rfc5545#section-3.3.10) string (e.g. `FREQ=WEEKLY;BYDAY=MO`). Good for deadlines and standing commitments.

### Calendar series linking

A `fixedSchedule` routine can be linked to a Google Calendar recurring event series via `calendarEventId` + `calendarIntegrationId`. The app supports both directions:

- **App-owned**: the app creates the RRULE and pushes a new recurring series to Google Calendar.
- **Import**: the user attaches an existing Google Calendar recurring series to the routine; the app follows Google's schedule.

Each generated item instance carries `routineId` pointing back to its parent routine, and inherits the routine's `template` fields (`workContextIds`, `peopleIds`, `energy`, `time`, `focus`, `urgent`).

---

## Sync Architecture

The app is designed to work **100% offline**. All mutations are recorded as operations and replayed against the server when connectivity is restored.

### Operations log (server-side)

Every change to any entity (`item`, `routine`, `person`, `workContext`) is recorded as an `OperationInterface` document on the server. Each operation stores:

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

Calendar integration is modelled via `CalendarIntegrationInterface`, which stores OAuth credentials for a connected Google Calendar account plus the target `calendarId`.

### Item-level sync
A `calendar` item can be linked to a specific Google Calendar event via `calendarEventId` + `calendarIntegrationId`. Changes flow bidirectionally: updates in the app push to Google; webhook or poll updates from Google are reflected back on the item.

### Routine-level sync
A `fixedSchedule` routine can be linked to a Google Calendar recurring event series (see [Routines](#routines-recurring-tasks) above).

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
    calendarEventId?: string;
    calendarIntegrationId?: string;
    routineId?: string;              // ref to routines._id
    energy?: 'low' | 'medium' | 'high';
    time?: number;                   // estimated minutes
    focus?: boolean;
    urgent?: boolean;
}
```

MongoDB indexes: `{ user }`, `{ user, status }`, `{ user, expectedBy }`, `{ user, timeStart }`, `{ user, updatedTs }`

---

### `routines`

```typescript
interface RoutineInterface {
    _id: string;
    user: string;
    title: string;
    triggerMode: 'afterCompletion' | 'fixedSchedule';
    afterCompletionDelayDays?: number;
    rrule?: string;                  // RFC 5545 RRULE
    calendarEventId?: string;
    calendarIntegrationId?: string;
    template: {
        workContextIds?: string[];
        peopleIds?: string[];
        energy?: 'low' | 'medium' | 'high';
        time?: number;
        focus?: boolean;
        urgent?: boolean;
    };
    active: boolean;
    createdTs: string;
    updatedTs: string;
}
```

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

MongoDB indexes: `{ user, ts }`, `{ user, deviceId }`, `{ user, entityId }`

---

### `deviceSyncState`

```typescript
interface DeviceSyncStateInterface {
    _id: string;        // stable device UUID (client-generated on first launch)
    user: string;
    lastSyncedTs: string;
    lastSeenTs: string;
    name?: string;
}
```

---

### `calendarIntegrations`

```typescript
interface CalendarIntegrationInterface {
    _id: string;
    user: string;
    provider: 'google';
    accessToken: string;   // encrypted at rest
    refreshToken: string;  // encrypted at rest
    tokenExpiry: string;
    calendarId: string;
    lastSyncedTs?: string;
    createdTs: string;
    updatedTs: string;
}
```
