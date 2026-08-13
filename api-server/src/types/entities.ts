export const ItemStatus = {
    inbox: 'inbox',
    nextAction: 'nextAction',
    calendar: 'calendar',
    waitingFor: 'waitingFor',
    somedayMaybe: 'somedayMaybe',
    done: 'done',
    trash: 'trash',
} as const;
export type ItemStatus = (typeof ItemStatus)[keyof typeof ItemStatus];

export type EnergyLevel = 'low' | 'medium' | 'high';
export type EntityType = 'item' | 'routine' | 'person' | 'workContext';
export type OpType = 'create' | 'update' | 'delete' | 'rsvp';

/**
 * GCal-mirror types. Server-authoritative on inbound pulls (always overwritten); the only
 * local-write exceptions are RSVP (routed through opType:'rsvp') and the attendee editor
 * (pushed through the standard update with `gcalMeta.sendUpdates`).
 */
export interface GCalPerson {
    email: string;
    displayName?: string;
    self?: boolean;
}
export type GCalResponseStatus = 'needsAction' | 'accepted' | 'declined' | 'tentative';
export interface GCalAttendee extends GCalPerson {
    responseStatus: GCalResponseStatus;
    organizer?: boolean;
    optional?: boolean;
}
// `fromGmail` is Google's eventType for events auto-created from Gmail (e.g. an event attached to
// an email). It surfaces in normal sync payloads — we must accept it on inbound and on echo writes
// from the client; rejecting it at the strict-mode Zod gate broke every sync push for items
// auto-imported from Gmail.
export type GCalEventType = 'default' | 'outOfOffice' | 'focusTime' | 'workingLocation' | 'fromGmail';

/** Keys overwritten verbatim from inbound GCal — replaceById must clear these when absent. */
export const GCAL_OWNED_ITEM_KEYS = ['organizer', 'creator', 'attendees', 'responseStatus', 'eventType', 'meetingLink', 'location', 'htmlLink'] as const;

/**
 * Mirrors `GCAL_OWNED_ITEM_KEYS` for the routine surface (RFC 5545 master) and per-instance overrides.
 * Routines store master attendees/organizer/etc. so the regenerator can copy them onto generated items;
 * per-instance overrides under `routineExceptions[]` carry the same set when they differ from the master.
 */
export const GCAL_OWNED_ROUTINE_KEYS = ['organizer', 'creator', 'attendees', 'responseStatus', 'eventType', 'meetingLink', 'location', 'htmlLink'] as const;

export interface ItemInterface {
    /**
     * Client-generated UUID used as the MongoDB _id. Optional so MongoDB accepts documents created without one (e.g. in tests) but always present in practice.
     */
    _id?: string;
    user: string; // Better Auth user ID (UUID string, not ObjectId)
    status: ItemStatus;
    title: string;
    createdTs: string; // ISO datetime
    updatedTs: string; // ISO datetime — used as the conflict-resolution anchor (last write wins)
    /**
     * Refs to WorkContextInterface._id. Relevant for `nextAction` items.
     */
    workContextIds?: string[];
    /**
     * Refs to PersonInterface._id. Relevant for `nextAction` and `waitingFor` items.
     */
    peopleIds?: string[];
    /**
     * Ref to PersonInterface._id. The specific person being waited on. Optional even on `waitingFor`
     * items — a delegated/blocked item need not name a person (e.g. "waiting for a part to arrive").
     */
    waitingForPersonId?: string;
    /**
     * Deadline date (one-day resolution, ISO date string). Relevant for `nextAction`, `waitingFor`,
     * and `somedayMaybe` items.
     */
    expectedBy?: string;
    /**
     * Tickler date (ISO date string). Item is hidden from all lists until this date passes.
     * Applies to `nextAction`, `waitingFor`, and `somedayMaybe` items — `calendar` items ignore
     * this field. Separate from `timeStart` to avoid overloading.
     */
    ignoreBefore?: string;
    /**
     * Calendar event start. ISO datetime string for timed events; `YYYY-MM-DD` when `allDay === true`.
     * `calendar` items only.
     */
    timeStart?: string;
    /**
     * Calendar event end. ISO datetime string for timed events; `YYYY-MM-DD` (exclusive — GCal's
     * convention) when `allDay === true`. `calendar` items only.
     */
    timeEnd?: string;
    /**
     * External calendar event ID (e.g. Google Calendar event ID). Set when this item is synced to a calendar.
     */
    calendarEventId?: string;
    /**
     * Ref to CalendarIntegrationInterface._id. Identifies which calendar integration owns the synced event.
     */
    calendarIntegrationId?: string;
    /**
     * Ref to CalendarSyncConfigInterface._id. Tracks which specific calendar within the integration this event belongs to.
     */
    calendarSyncConfigId?: string;
    /**
     * Disconnect-with-keep markers — set when the user disconnects an integration with
     * `keepLinkedEntities`, capturing the prior `calendar*` ids so a later reconnect can do a
     * strong-key relink without depending on title+time fallback. All three are cleared atomically
     * the moment relink restores the live `calendar*` fields (`tryRestoreFromLastKnownEventId`).
     * The integration id is also used by the OAuth reconnect repair pass
     * (`reconcileLastKnownMarkers`): on a same-account reconnect it rewrites this id to the new
     * integration so the relink still fires; on a different-account reconnect it wipes the markers
     * (otherwise the item would be permanently un-pushable). Same-vs-different is decided by
     * `lastKnownCalendarAccountEmail` below.
     */
    lastKnownCalendarEventId?: string;
    lastKnownCalendarIntegrationId?: string;
    lastKnownCalendarSyncConfigId?: string;
    /**
     * The Google account email (lowercased) that owned the integration when these markers were stamped
     * at disconnect. Lets the reconnect repair pass distinguish a same-account reconnect (rewrite the
     * markers) from a different-account one (wipe them). Absent on legacy markers ⇒ treated as unknown,
     * which falls back to the safe wipe.
     */
    lastKnownCalendarAccountEmail?: string;
    /**
     * Set on routine-generated calendar items so exception sync can locate them even after their
     * `timeStart` has been shifted by a prior exception. Format: `<masterEventId>_<YYYYMMDDTHHMMSSZ>`
     * (e.g. `4l19d4t1kqscltspotnhpiopci_20260519T120000Z`) — matches what Google returns in
     * `event.id` for instances of a recurring series.
     */
    calendarInstanceEventId?: string;
    /**
     * ISO datetime — set when the app pushes an edit to Google Calendar.
     * Used to detect and skip our own echo when a webhook-triggered pull finds the same change.
     */
    lastPushedToGCalTs?: string;
    /**
     * ISO datetime — equal to `event.updated` of the most recent inbound GCal payload applied
     * to this item. Used as the conflict-resolution anchor for inbound GCal updates so that
     * local-only writes (e.g. trash-on-disconnect bumping `updatedTs`) cannot lock GCal out
     * of reasserting state.
     */
    lastSyncedFromGCalTs?: string;
    /**
     * Ref to RoutineInterface._id. Set when this item was generated by a routine.
     */
    routineId?: string;
    energy?: EnergyLevel; // relevant for `nextAction` items
    time?: number; // estimated duration in minutes — relevant for `nextAction` items
    focus?: boolean; // on the current-focus shortlist (Nirvana-style Focus list) — floats the item to the top of Next Actions; relevant for `nextAction` items
    urgent?: boolean; // must be done very soon — relevant for `nextAction` items
    notes?: string; // freeform markdown notes — applies to all statuses
    /**
     * The last notes value successfully synced from/to Google Calendar.
     * Used to detect whether Google's description changed since the last inbound sync,
     * enabling last-write-wins conflict resolution only when GCal actually changed it.
     */
    lastSyncedNotes?: string;
    /**
     * When true on a `calendar` item, `timeStart` and `timeEnd` are `YYYY-MM-DD` strings
     * (GCal's exclusive-end convention preserved verbatim) rather than ISO datetimes.
     */
    allDay?: boolean;
    /** GCal organizer of this event. Server-overwritten on every inbound pull. */
    organizer?: GCalPerson;
    /** GCal creator of this event (often equal to organizer). Server-overwritten. */
    creator?: GCalPerson;
    /** Attendees, sorted by email for stable equality. Server-overwritten. */
    attendees?: GCalAttendee[];
    /** Denormalized from `attendees.find(a => a.self)?.responseStatus`. GCal-owned with RSVP write exception. */
    responseStatus?: GCalResponseStatus;
    /** GCal event type — usually `'default'`; outOfOffice/focusTime/workingLocation/fromGmail are special. Server-overwritten. */
    eventType?: GCalEventType;
    /** Conferencing join URL — Meet `hangoutLink` or the `video` entry point from conferenceData (e.g. Zoom). GCal-owned; read-only in-app. */
    meetingLink?: string;
    /** Free-text / physical location from the GCal `location` field. GCal-owned; read-only in-app. */
    location?: string;
    /** Canonical Google Calendar event URL (`htmlLink`); opens the event in the GCal UI. GCal-owned; read-only in-app. */
    htmlLink?: string;
    /** Server-set to true when an inbound GCal cancellation pushed this item to trash. UI surfaces it as a badge. */
    cancelledByGCal?: boolean;
    /**
     * Caller-supplied dedupe key, set only by the public API. Sparse-unique on (user, externalId)
     * so re-running an import with the same key upserts instead of creating duplicates.
     */
    externalId?: string;
    /**
     * sha256 of `${title}\n${notes ?? ''}` at creation time. Set only by the public API on inbox items
     * so a duplicate capture within the dedupe window can return the existing item instead of inserting
     * a new one. Recomputed only on create — later edits do not update it.
     */
    contentHash?: string;
}

export interface RoutineItemTemplate {
    workContextIds?: string[];
    peopleIds?: string[];
    energy?: EnergyLevel;
    time?: number; // estimated minutes
    focus?: boolean; // generated items start on the current-focus shortlist (floats to the top of Next Actions)
    urgent?: boolean;
    notes?: string;
}

export interface RoutineInterface {
    _id: string;
    user: string;
    title: string;
    /**
     * nextAction: next instance created after previous is done/trashed (all frequencies are after-completion).
     * calendar: next instance created on a fixed rrule schedule.
     */
    routineType: 'nextAction' | 'calendar';
    /**
     * RFC 5545 RRULE string (e.g. FREQ=WEEKLY;BYDAY=MO). Required for all routines.
     * For nextAction routines, DTSTART is set dynamically to the completion date when computing the next occurrence.
     * For calendar routines, DTSTART is the routine's creation date (fixed absolute schedule).
     */
    rrule: string;
    /**
     * Only meaningful for `routineType: 'nextAction'`. Modifies what `rrule` gets written as — it
     * is NOT a separate computation path; `rrule` remains the single source of truth for actual
     * date computation (`computeNextOccurrence` never branches on this field).
     * - 'floating': `rrule` omits BYMONTHDAY/BYDAY, so the next occurrence's day-of-period floats
     *   to whatever day the item is actually completed on (rrule's own DTSTART-day semantics).
     * - 'fixed': `rrule` carries an explicit BYMONTHDAY/BYDAY, so the next occurrence is always
     *   pinned to that day regardless of completion date.
     * `undefined` means "derive from whether `rrule` currently has BYMONTHDAY/BYDAY" — see
     * `deriveRecurrenceAnchor` in `lib/rruleHelpers.ts`. This keeps existing routines' behavior
     * unchanged; the field only becomes concretely set once explicitly written.
     */
    recurrenceAnchor?: 'floating' | 'fixed';
    /**
     * @deprecated Use routineType instead.
     */
    triggerMode?: 'afterCompletion' | 'fixedSchedule';
    /**
     * @deprecated Use rrule instead.
     */
    afterCompletionDelayDays?: number;
    /**
     * Google Calendar recurring event series ID. Set when the routine is linked to a calendar series.
     */
    calendarEventId?: string;
    /**
     * GCal master organizer/creator/attendees/responseStatus/eventType. Mirrors `ItemInterface`'s
     * GCal-owned fields per RFC 5545: the recurring series carries one canonical attendee list which
     * applies to every generated occurrence unless a per-instance exception overrides it. Always
     * overwritten on inbound master refresh; see `GCAL_OWNED_ROUTINE_KEYS`.
     */
    organizer?: GCalPerson;
    creator?: GCalPerson;
    attendees?: GCalAttendee[];
    responseStatus?: GCalResponseStatus;
    eventType?: GCalEventType;
    /** GCal master conferencing/location/event-URL — mirrored onto generated items. See `GCAL_OWNED_ROUTINE_KEYS`. */
    meetingLink?: string;
    location?: string;
    htmlLink?: string;
    /**
     * Ref to CalendarIntegrationInterface._id. Identifies which calendar integration owns the series.
     */
    calendarIntegrationId?: string;
    /**
     * Ref to CalendarSyncConfigInterface._id. Tracks which specific calendar within the integration this routine is linked to.
     */
    calendarSyncConfigId?: string;
    /**
     * Disconnect-with-keep markers — set when the user disconnects an integration with
     * `keepLinkedEntities`, capturing the prior `calendar*` ids so a later reconnect can do a
     * strong-key relink without depending on the title+rrule+timeOfDay fallback. All three are
     * cleared atomically the moment relink restores the live `calendar*` fields
     * (`tryRestoreRoutineFromLastKnownEventId`). The integration id is also used by the OAuth
     * reconnect repair pass (`reconcileLastKnownMarkers`): same-account reconnect rewrites it to the
     * new integration so the relink fires; different-account reconnect wipes the markers (else the
     * routine is permanently un-pushable). Same-vs-different is decided by `lastKnownCalendarAccountEmail`.
     */
    lastKnownCalendarEventId?: string;
    lastKnownCalendarIntegrationId?: string;
    lastKnownCalendarSyncConfigId?: string;
    /** See `ItemInterface.lastKnownCalendarAccountEmail` — origin Google account email of these markers. */
    lastKnownCalendarAccountEmail?: string;
    /**
     * Ref to the routine this was split from via a "this and all following" edit.
     * Set on the new tail routine; points back to the original (head) routine.
     */
    splitFromRoutineId?: string;
    /**
     * Raw GCal rebased-master id (`<bareId>_R<anchor>`) when this routine is the open-ended tail of a
     * "this and all following" split. `calendarEventId` stores the BARE id (so generated items match
     * GCal's bare-id instance ids), which means multiple split tails on one series share a
     * `calendarEventId` and cannot be told apart by it. The rebased id is the only stable per-tail key:
     * keying split-successor onboarding on it makes re-import idempotent — a re-reported `_R` master
     * updates the same successor instead of minting a fresh routine each webhook fire (which otherwise
     * grew an unbounded routine chain on RSVP-churny series).
     */
    calendarRebasedEventId?: string;
    /**
     * ISO datetime — set when the app pushes an edit to Google Calendar.
     * Used to detect and skip our own echo when a webhook-triggered pull finds the same change.
     */
    lastPushedToGCalTs?: string;
    /**
     * The last template.notes value successfully synced from/to Google Calendar.
     * See ItemInterface.lastSyncedNotes for full semantics.
     */
    lastSyncedNotes?: string;
    /**
     * ISO datetime — equal to `event.updated` of the most recent inbound GCal master payload applied
     * to this routine. The structural conflict-resolution anchor for inbound GCal updates (rrule,
     * title, schedule), so local-only writes (or no-op exception churn) that bump `updatedTs` cannot
     * lock GCal out of reasserting the series schedule. See ItemInterface.lastSyncedFromGCalTs.
     */
    lastSyncedFromGCalTs?: string;
    /**
     * Fields copied onto each item instance generated by this routine.
     */
    template: RoutineItemTemplate;
    active: boolean;
    /**
     * True when the routine was deactivated because Google Calendar cancelled its series (the
     * cancelled-master branch or the orphaned-successor reap — both via `deactivateRoutineFromGCal`).
     * Mirrors `ItemInterface.cancelledByGCal`. The `/maintenance` heal endpoints treat a marked row as
     * a DELIBERATE retirement and never resurrect it — without this marker, `healStuckGCalRoutines`
     * matches the exact shape a retirement leaves behind (`!active || past UNTIL`) and regenerates the
     * phantom items the retirement removed. Cleared whenever a structurally-newer CONFIRMED master
     * arrives for the routine (GCal itself proving the series alive supersedes the stale marker).
     */
    retiredByGCal?: boolean;
    createdTs: string;
    updatedTs: string;
    /**
     * ISO date (YYYY-MM-DD) — anchors the rrule schedule. Falls back to createdTs when unset.
     * User-editable in the routine edit dialog. For calendar routines, becomes the GCal series DTSTART
     * (snapped forward to the first BYDAY/BYMONTHDAY match by seriesStartDate). For nextAction routines,
     * no items are generated with an occurrence date before startDate.
     */
    startDate?: string;
    /**
     * Present when routineType === 'calendar'. Defines time + duration (or all-day flag) for generated calendar items.
     * When `allDay === true`, `timeOfDay` and `duration` are ignored; generated items are all-day single-day occurrences.
     */
    calendarItemTemplate?: {
        allDay?: boolean;
        timeOfDay?: string; // HH:MM (24h) — start time. Required when !allDay.
        duration?: number; // minutes. Required when !allDay.
    };
    /**
     * ISO date string of the most recently generated calendar item's date.
     * Used to compute the next occurrence without scanning items.
     */
    lastGeneratedDate?: string;
    /**
     * Exception records: dates in the rrule series that have been overridden or deleted.
     * When a user trashes a future calendar item, its date is recorded here as 'skipped'
     * so the next-item generator skips that occurrence.
     */
    routineExceptions?: Array<{
        date: string; // ISO date of the original rrule occurrence
        type: 'skipped' | 'modified';
        itemId?: string;
        newTimeStart?: string; // ISO datetime — present when type === 'modified'
        newTimeEnd?: string;
        title?: string; // overridden title — present when GCal instance title differs from master
        notes?: string; // overridden description — present when GCal instance description differs from master
        /**
         * Per-instance GCal-owned override fields (RFC 5545: each modified instance is its own VEVENT
         * with its own attendees). Only emitted when the instance value differs from the master; an
         * absent key means "inherit from master". Server-overwritten on inbound exception refresh.
         */
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

export interface PersonInterface {
    _id: string;
    user: string;
    name: string;
    email?: string;
    phone?: string;
    /**
     * Google Calendar "other person's calendar" ID, used for scheduling meetings with them.
     */
    externalCalendarId?: string;
    notes?: string;
    /**
     * Retired from active use: hidden from pickers and filter rows in the client, but existing
     * item references stay intact and render. Absent ⇒ active. Full-snapshot LWW: a client that
     * omits this field on an update clears it, so pre-`archived` client builds unarchive on any
     * edit — acceptable because the flag is purely a display filter.
     */
    archived?: boolean;
    createdTs: string;
    updatedTs: string;
}

export interface WorkContextInterface {
    _id: string;
    user: string;
    /**
     * Human-readable label, e.g. "near a phone", "at work", "with family", "focused at laptop".
     */
    name: string;
    /**
     * Retired from active use: hidden from pickers and filter rows in the client, but existing
     * item references stay intact and render. Absent ⇒ active. Full-snapshot LWW: a client that
     * omits this field on an update clears it, so pre-`archived` client builds unarchive on any
     * edit — acceptable because the flag is purely a display filter.
     */
    archived?: boolean;
    createdTs: string;
    updatedTs: string;
}

/**
 * Payload for an `rsvp` opType: a local RSVP click that needs to push the user's responseStatus
 * to GCal as the only sanctioned local-write into the GCal-owned attendee set. Carried in the
 * op log so an offline RSVP replays correctly on reconnect.
 */
export interface RsvpOpPayload {
    itemId: string;
    calendarEventId: string;
    calendarIntegrationId: string;
    responseStatus: GCalResponseStatus;
}

/** Reason an op's GCal-side effect could not be applied. UI maps each to a remediation action. */
export type OpFailureReason = 'transient_exhausted' | 'scope_missing' | 'calendar_missing' | 'edit_conflict' | 'terminal';

export interface OperationInterface {
    _id: string; // server-generated UUID
    user: string;
    /**
     * Stable device UUID generated on first app launch. Identifies the originating device.
     */
    deviceId: string;
    ts: string; // ISO datetime — when the change was made on the device
    entityType: EntityType;
    entityId: string;
    opType: OpType;
    /**
     * Full entity state at the time of the operation. null for delete operations.
     * Stored to allow any device to reconstruct state by replaying operations in ts order.
     * For opType === 'rsvp', snapshot is null and rsvp lives in `rsvp` sidecar instead.
     */
    snapshot: ItemInterface | RoutineInterface | PersonInterface | WorkContextInterface | null;
    /**
     * Sidecar for GCal-coupled writes. Populated when the user picked Send/Don't Send in the
     * SendUpdatesDialog so the choice survives offline queueing and replays through pushback.
     */
    gcalMeta?: { sendUpdates: 'all' | 'none' };
    /**
     * Pre-update snapshot of a calendar item whose update transitions it to an active
     * non-calendar status (inbox/nextAction/waitingFor/somedayMaybe). Clients strip the GCal
     * linkage fields off such snapshots before pushing, so by the time pushback runs the op
     * itself no longer knows which GCal event to remove — this sidecar (hydrated server-side
     * before `applyEntityOp` overwrites the row) carries that evidence. Absent otherwise.
     *
     * Intentionally persisted with the op (not stripped before insert): detach ops are rare, the
     * duplicate snapshot is small relative to op-log volume, and keeping it makes the persisted
     * op self-describing for audits/replays. Clients ignore unknown op fields on pull.
     */
    detachedCalendar?: ItemInterface;
    /**
     * RSVP payload for opType === 'rsvp'. Required when opType === 'rsvp'; absent otherwise.
     */
    rsvp?: RsvpOpPayload;
    /** Set true when the GCal-side effect failed after retry. Surfaced via SyncIssuesPanel. */
    syncFailed?: boolean;
    failureReason?: OpFailureReason;
    failureDetail?: string;
    failedTs?: string;
}

/**
 * Cursor sentinel that sorts strictly above every operation `_id` (UUIDs and the public-API's
 * base62 ids alike — all printable ASCII, which sorts below U+FFFF). Used as the `serverId`
 * component of a bootstrap cursor: the bootstrap snapshot already contains every op at exactly
 * `serverTs`, so the floor `(serverTs, MAX_OP_ID)` correctly means "everything ≤ serverTs is
 * delivered" without re-delivering those ops on the first incremental pull. NEVER use this for a
 * mid-stream incremental cursor — it would skip the rest of a same-`ts` tie-group (the very bug the
 * compound `(ts, _id)` cursor exists to prevent); use `''` (lowest id) there to re-check the ms.
 */
export const MAX_OP_ID = '￿';

export interface DeviceSyncStateInterface {
    /**
     * Composite id `${deviceId}::${userId}`. One row per (device, user) pair so two
     * Better Auth sessions on the same device each track their own pull cursor — a
     * single shared cursor would let one user's pull advance past the other user's
     * boundary op (the bug fixed by per-user cursors).
     */
    _id: string;
    /**
     * Stable device UUID (client-generated on first launch). Duplicated as a queryable
     * field so device-scoped operations (stale-device cleanup, push-subscription
     * removal) can scan by deviceId without parsing `_id`.
     */
    deviceId: string;
    user: string;
    /**
     * ISO datetime of the most recent operation this (device, user) pair has pulled
     * from the server. Operations older than the minimum lastSyncedTs across all
     * (device, user) rows for a user can be purged.
     */
    lastSyncedTs: string;
    /**
     * `_id` of the most recent operation this (device, user) pair has pulled, paired with
     * `lastSyncedTs` to form the compound `(ts, _id)` purge floor. Two ops in one push batch share
     * an identical `lastSyncedTs`, so the `_id` component is what lets the purge delete only the
     * same-`ts` ops at-or-below this exact position and keep the unacked survivors. Legacy rows
     * written before this field existed are read as `''` (lowest id) — see purgeOldOperations.
     */
    lastSyncedId: string;
    /**
     * ISO datetime of the most recent operation this (device, user) pair has pushed
     * to the server.
     */
    lastSeenTs: string;
    name?: string; // user-given label, e.g. "iPhone", "Work laptop" — set via PATCH /devices/:deviceId, wins over autoLabel
    /**
     * Client-derived label sent with /sync/bootstrap (e.g. "Chrome on macOS"). Refreshed on every
     * bootstrap; display fallback when the user hasn't named the device. Rows created before this
     * field existed (or via /sync/pull cursor writes alone) have neither — the UI shows a generic
     * "Unknown device" for those.
     */
    autoLabel?: string;
}

/**
 * Compose the deviceSyncState document _id from a (deviceId, userId) pair.
 * Invariant: neither deviceId nor userId may contain `::` — UUIDs (deviceIds) and Better Auth
 * user IDs never do, but we throw defensively so a future ID-format change can't silently
 * corrupt the legacy-row detection in `migrateDeviceSyncStateToPerUserCursor`.
 */
export function deviceSyncStateId(deviceId: string, userId: string): string {
    if (deviceId.includes('::') || userId.includes('::')) {
        throw new Error(`deviceSyncStateId: '::' is reserved as the deviceId/userId separator (deviceId=${deviceId}, userId=${userId})`);
    }
    return `${deviceId}::${userId}`;
}

export interface PushSubscriptionRecord {
    _id: string; // deviceId — one record per device, so upsert by deviceId keeps it current
    /**
     * Better Auth user ID of the account that registered the subscription.
     * Informational only: a single device may host several logged-in accounts; reads of
     * "which devices to push to for user X" go through `deviceUsers` joined on `deviceId`.
     */
    user: string;
    endpoint: string;
    keys: { p256dh: string; auth: string };
    updatedTs: string;
}

/**
 * Join row recording every (device, user) pair the device currently hosts a Better Auth session for.
 * Maintained by the auth middleware on every authenticated request and removed on signOut /
 * push subscription expiry.
 */
export interface DeviceUserInterface {
    /** Composite key `<deviceId>:<userId>` — one row per (device, user) pair. */
    _id: string;
    deviceId: string;
    userId: string;
    createdTs: string; // ISO datetime — first time this device announced this user
    lastSeenTs: string; // ISO datetime — most recent authenticated request from this device for this user
}

export interface CalendarIntegrationInterface {
    _id: string;
    user: string;
    provider: 'google'; // extensible: 'apple' | 'microsoft' in future
    accessToken: string; // OAuth access token — must be encrypted at rest
    refreshToken: string; // OAuth refresh token — must be encrypted at rest
    tokenExpiry: string; // ISO datetime
    /**
     * @deprecated Per-calendar sync state moved to `CalendarSyncConfigInterface` (one config row per
     * synced calendar). New integrations no longer write this field; legacy rows keep it for lazy
     * migration in `ensureSyncConfigExists`. New code paths must read sync configs instead.
     */
    calendarId?: string;
    lastSyncedTs?: string; // ISO datetime of last successful pull from this calendar
    /**
     * OAuth auth state. Absent ⇒ treated as `'active'`. Lifecycle:
     *  - `'active'`: tokens believed valid; sync + pushback proceed normally.
     *  - `'suspended'`: a refresh attempt failed with `invalid_grant`; warning email sent. Sync still
     *     attempts (the failure may have been transient); after 24h elapsed since `suspendedAt` the
     *     escalation flips status to `'revoked'`.
     *  - `'revoked'`: soft-deleted. Sync/pushback skip; sync endpoint returns HTTP 410. Reconnect via
     *     OAuth (`upsertEncrypted`) clears status back to `'active'`.
     */
    status?: 'active' | 'suspended' | 'revoked';
    /**
     * The Google account email this integration authorized (lowercased). Set from the OAuth callback's
     * `authorizedEmail`. Used to tell a same-account reconnect (rewrite the disconnect markers to the
     * new integration id) from a genuinely different-account reconnect (wipe the now-orphaned markers).
     * Absent on legacy rows → callers treat the identity as unknown and fall back to the safe wipe.
     */
    accountEmail?: string;
    suspendedAt?: string; // ISO datetime — set when first invalid_grant detected
    revokedAt?: string; // ISO datetime — set when 24h grace expires
    lastAuthErrorAt?: string; // ISO datetime — bumped on every invalid_grant occurrence
    /**
     * OAuth scopes actually granted by Google on the most recent consent. Populated from
     * `tokens.scope` in the OAuth callback. Absent on legacy integrations → treated as permissive
     * (those users authorized the full `auth/calendar` scope). New consents stamp it explicitly.
     */
    grantedScopes?: string[];
    createdTs: string;
    updatedTs: string;
}

/**
 * Audit row for outbound emails. The current `sendEmail` implementation is a stub that logs and
 * persists this row; a real email provider replaces the body of `sendEmail` while preserving this
 * audit log so prior sends remain queryable.
 */
export interface SentEmailInterface {
    _id: string;
    userId: string;
    to: string;
    subject: string;
    body: string;
    kind: 'calendar_auth_warning' | 'calendar_auth_revoked';
    sentAt: string;
}

export interface CalendarSyncConfigInterface {
    _id: string;
    /** Ref to CalendarIntegrationInterface._id — the OAuth integration this calendar belongs to. */
    integrationId: string;
    user: string;
    /** Google Calendar ID (e.g. 'primary', 'work@group.calendar.google.com'). */
    calendarId: string;
    /** Human-readable calendar name from Google (e.g. "Work", "Holidays"). */
    displayName?: string;
    /** When true, new app-created calendar items default to this calendar. Only one config per integration may be default. */
    isDefault: boolean;
    /** User can pause sync for individual calendars without removing them. */
    enabled: boolean;
    /** ISO datetime of last successful pull from this specific calendar. */
    lastSyncedTs?: string;
    /** Google incremental sync token — used to fetch only changed events since last sync. */
    syncToken?: string;
    /** UUID for the Google Calendar push notification channel. */
    webhookChannelId?: string;
    /** Google's resource ID for the active watch. Paired with webhookChannelId for verification. */
    webhookResourceId?: string;
    /** ISO datetime when the webhook channel expires and must be renewed. */
    webhookExpiry?: string;
    /** IANA timezone of this calendar (e.g. "Asia/Jerusalem"). Fetched from Google, refreshed on sync. */
    timeZone?: string;
    createdTs: string;
    updatedTs: string;
}

/** Union of all entity types that can appear as an operation snapshot. */
export type EntitySnapshot = ItemInterface | RoutineInterface | PersonInterface | WorkContextInterface;

/** Discrete event types webhooks can subscribe to. Adding a new event requires extending `mapOpToEvents`. */
export type WebhookEvent = 'item.created' | 'item.completed';

export const VALID_WEBHOOK_EVENTS: ReadonlySet<WebhookEvent> = new Set(['item.created', 'item.completed']);

/**
 * Outbound webhook subscription. The user provides a `url` and an `events` filter; the
 * server enqueues a delivery for each matching public-API mutation, signs the payload with
 * `secret` (HMAC-SHA256), and POSTs to the URL. Subscriptions auto-disable after enough
 * consecutive failures so a dead endpoint can't keep generating zombie deliveries.
 */
export interface WebhookSubscriptionInterface {
    _id: string;
    user: string;
    url: string;
    events: WebhookEvent[];
    /** HMAC-SHA256 secret. 32 random bytes, base64url. Shown to the caller exactly once at creation. */
    secret: string;
    createdTs: string;
    /** Bumped on every successful 2xx delivery. */
    lastDeliveredTs?: string;
    /** Consecutive failures since the last success. Resets to 0 on a 2xx delivery. */
    failureCount?: number;
    /** Set when the subscription was auto-disabled or revoked. New events for disabled subs are not enqueued. */
    disabledTs?: string;
    disabledReason?: string;
}

/**
 * One pending or completed delivery attempt. Acts as both queue (`deliveredTs unset, abandonedTs unset`)
 * and audit log (rows are kept after delivery for diagnostics, with TTL governed by the surrounding
 * operations cleanup story rather than by a separate purge).
 */
export interface WebhookDeliveryInterface {
    _id: string;
    user: string;
    subscriptionId: string;
    event: WebhookEvent;
    /** Snapshot of the payload at enqueue time — deliveries cannot drift if the source entity changes. */
    payload: unknown;
    /** Number of attempts so far (0 before the first send). */
    attempts: number;
    /** Earliest time the worker should pick this up. Pushed forward on retry. */
    nextAttemptTs: string;
    lastError?: string;
    deliveredTs?: string;
    abandonedTs?: string;
    /** Optimistic-lock claim flag: set true while a worker is delivering, reset on completion. */
    claimed?: boolean;
}

/**
 * Capability scopes granted to a personal API token. A token is permitted to perform any
 * action whose scope appears in its `scopes` array. Issuing tokens with the smallest possible
 * scope set is the right hygiene; e.g. a Raycast capture extension only needs `items.capture`.
 *
 * **Reassign is a two-token gesture.** `reassign` lets a token move entities OUT of its user
 * to another user; `reassign.accept` lets *another* token move entities INTO this user. The
 * `/v1/reassign` route requires both — the calling token's `reassign` plus the recipient
 * token's `reassign.accept` (sent in `X-Reassign-Recipient-Token`). This is the bearer-token
 * analog of the device-multi-session check enforced by the in-app `/sync/reassign`.
 */
export type ApiTokenScope =
    | 'items.capture'
    | 'items.read'
    | 'items.write'
    | 'routines.read'
    | 'routines.write'
    | 'people.read'
    | 'people.write'
    | 'contexts.read'
    | 'contexts.write'
    | 'reassign'
    | 'reassign.accept'
    | 'webhooks.manage'
    // Gates the Lane A Claude-assist endpoints (`/v1/claude/assist` + `/apply`). A distinct scope
    // (not `items.write`) so a token can be granted the agent surface without broad write access,
    // and so agent usage is independently auditable/revocable.
    | 'claude.assist';

/** Default scopes minted onto a token when the caller did not specify any. */
export const DEFAULT_API_TOKEN_SCOPES: ApiTokenScope[] = ['items.capture', 'items.read'];

/** Allowlist enforced by the token mint endpoint. Currently every scope is mintable. */
export const MINTABLE_API_TOKEN_SCOPES: ReadonlySet<ApiTokenScope> = new Set([
    'items.capture',
    'items.read',
    'items.write',
    'routines.read',
    'routines.write',
    'people.read',
    'people.write',
    'contexts.read',
    'contexts.write',
    'reassign',
    'reassign.accept',
    'webhooks.manage',
    'claude.assist',
]);

/**
 * Personal API token issued by the user from the app's settings page. Authenticates calls to
 * the public `/v1/*` API. Only the sha256 hash is stored — the plaintext is shown to the user
 * exactly once at creation.
 */
export interface ApiTokenInterface {
    _id: string;
    user: string; // Better Auth user ID
    /** sha256 hex of the plaintext token (`gtd_<random>`). Unique. */
    tokenHash: string;
    /** Human label provided at creation, e.g. "iOS Shortcut", "Local MCP". */
    label: string;
    createdTs: string;
    /**
     * Capabilities the token is allowed to exercise. Pre-scopes tokens have this field absent;
     * the bearer middleware lazily backfills `DEFAULT_API_TOKEN_SCOPES` on first use so the
     * scope check downstream always sees a populated array.
     */
    scopes?: ApiTokenScope[];
    /** Updated best-effort on every authenticated request. May lag a few seconds behind. */
    lastUsedTs?: string;
    /** Set when the token was revoked. Once set, the token can never authenticate again. */
    revokedTs?: string;
    /**
     * Set on OAuth-issued access tokens (the remote MCP flow); absent on personal settings-minted
     * tokens, which never expire. ISO datetime. Auth resolution rejects tokens whose `expiresTs`
     * is in the past — enforced INSIDE the Mongo query so the no-cache revocation guardrail holds.
     */
    expiresTs?: string;
    /** Token provenance. Absent ⇒ 'personal'. 'oauth_access' ⇒ short-lived, issued via /mcp-oauth/token. */
    kind?: 'personal' | 'oauth_access';
    /** For `kind:'oauth_access'`: the `oauthClients._id` that obtained it (surfaces as AuthInfo.clientId). */
    oauthClientId?: string;
}

/**
 * A registered OAuth 2.1 client (RFC 7591 Dynamic Client Registration) for the remote MCP flow.
 * `_id` IS the `client_id`. MCP clients are public (PKCE-only) by default — `clientSecretHash` is
 * absent for those. Only the sha256 hash of any secret is stored; the plaintext is returned once.
 */
export interface OAuthClientInterface {
    _id: string;
    /** sha256 hex of the client secret. Absent ⇒ public client (token_endpoint_auth_method 'none'). */
    clientSecretHash?: string;
    clientName?: string;
    /** Exact-match allowlist — the open-redirect gate. A redirect_uri must equal one of these verbatim. */
    redirectUris: string[];
    grantTypes: string[];
    tokenEndpointAuthMethod: 'none' | 'client_secret_post' | 'client_secret_basic';
    /** Scopes this client may request. The granted token's scopes are bounded by this set. */
    scopes: ApiTokenScope[];
    createdTs: string;
}

/**
 * A one-time OAuth authorization code (Authorization Code + PKCE). `_id` is the sha256 hash of the
 * code plaintext — the raw code is never stored. Bound to the user resolved at `/authorize` and to
 * the client/redirect/PKCE-challenge so `/token` can verify the redemption. Consumed atomically
 * (single `findOneAndUpdate` setting `consumedTs`) to defeat replay; ~60s TTL.
 */
export interface OAuthAuthCodeInterface {
    _id: string;
    user: string;
    clientId: string;
    redirectUri: string;
    /** S256 PKCE challenge (base64url). `plain` is never accepted. */
    codeChallenge: string;
    codeChallengeMethod: 'S256';
    scopes: ApiTokenScope[];
    /** ISO datetime, ~now+60s. Redemption requires `expiresTs > now`. */
    expiresTs: string;
    /** Set on first redemption. A second redemption finds it set → `invalid_grant` (replay guard). */
    consumedTs?: string;
    createdTs: string;
}

/**
 * A rotating OAuth refresh token. `_id` is the sha256 hash of the refresh plaintext. Rotated on
 * every use (OAuth 2.1): redemption sets `rotatedToId` atomically; a second redemption of the same
 * row (reuse) signals compromise → the whole family is revoked. Pairs with the access token it
 * minted via `accessTokenId` so rotation can revoke the prior access token.
 */
export interface OAuthRefreshTokenInterface {
    _id: string;
    user: string;
    clientId: string;
    scopes: ApiTokenScope[];
    /** The `apiTokens._id` of the access token this refresh currently pairs with (revoked on rotation). */
    accessTokenId?: string;
    /** Set when this refresh token is rotated. Its presence at redemption time = reuse → revoke family. */
    rotatedToId?: string;
    revokedTs?: string;
    expiresTs?: string;
    createdTs: string;
}

/**
 * Per-user-per-day Claude token-spend ledger (`claudeUsage` collection). One document per
 * `(user, day)`; the `_id` is the deterministic `${user}:${day}` key so the post-call increment
 * is a single atomic upsert. This is COGS instrumentation — the Lane A `/v1/claude/assist` handler
 * checks the running cost against the daily cap before each call and increments after, recording
 * spend even on a partial or failed loop.
 */
export interface ClaudeUsageInterface {
    /** `${user}:${day}` — deterministic upsert key. */
    _id: string;
    user: string; // Better Auth user ID
    /** UTC calendar day, `YYYY-MM-DD`. */
    day: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    /** Running USD estimate, summed from per-call usage at the model's published rates. */
    estimatedCostUsd: number;
    callCount: number;
    updatedTs: string;
}
