import type { GCalAttendee, GCalEventType, GCalPerson, GCalResponseStatus, RoutineInterface } from '../types/entities.js';

/** Result of an incremental or full event sync — includes events and the token for the next sync. */
export interface EventSyncResult {
    events: GCalEvent[];
    nextSyncToken: string;
    /**
     * Lower bound of the window a FULL sync covered (`timeMin`), in ISO. Present only on full syncs;
     * absent on incremental (syncToken) deltas. Its presence proves the `events` array is an
     * authoritative snapshot of `[fullSyncTimeMin, ∞)` — which lets the importer reconcile orphaned
     * local items against it (trash items whose GCal event vanished). An incremental delta is NOT a
     * snapshot, so the sweep must never run on one.
     */
    fullSyncTimeMin?: string;
}

/** Thrown when Google returns 410 Gone, meaning the stored syncToken is no longer valid. */
export class SyncTokenInvalidError extends Error {
    constructor() {
        super('Sync token is no longer valid (410 Gone). A full re-sync is required.');
        this.name = 'SyncTokenInvalidError';
    }
}

export interface GCalException {
    originalDate: string; // ISO date of the original rrule occurrence
    type: 'modified' | 'deleted';
    newTimeStart?: string; // ISO datetime — present when type === 'modified'
    newTimeEnd?: string;
    googleEventId?: string;
    title?: string; // overridden title — present when instance summary differs from master
    notes?: string; // overridden description — present when instance description differs from master
    /**
     * Per-instance GCal-owned override fields. Only set when the instance differs from the master
     * (RFC 5545 inheritance: missing keys mean "inherit from the master VEVENT"). The parser uses
     * `MasterContent` to diff each field against the master before emitting.
     */
    organizer?: GCalPerson;
    creator?: GCalPerson;
    attendees?: GCalAttendee[];
    responseStatus?: GCalResponseStatus;
    eventType?: GCalEventType;
    meetingLink?: string;
    location?: string;
    htmlLink?: string;
}

/**
 * Master event content passed to getExceptions() so it can detect content-only changes. Carries
 * the same GCal-owned fields the parser may need to diff against — when the instance value matches
 * the master, the exception omits that field so downstream consumers inherit from the master.
 */
export interface MasterContent {
    title: string;
    description: string;
    organizer?: GCalPerson;
    creator?: GCalPerson;
    attendees?: GCalAttendee[];
    eventType?: GCalEventType;
    meetingLink?: string;
    location?: string;
    htmlLink?: string;
}

export interface GCalEvent {
    id: string;
    title: string;
    /** ISO datetime for timed events; `YYYY-MM-DD` when `allDay === true`. */
    timeStart: string;
    /** ISO datetime for timed events; `YYYY-MM-DD` (exclusive — GCal's convention) when `allDay === true`. */
    timeEnd: string;
    updated: string; // ISO datetime — used for last-write-wins conflict resolution
    status: 'confirmed' | 'tentative' | 'cancelled';
    recurringEventId?: string; // set for instances that belong to a recurring series
    recurrence?: string[]; // present on master recurring event definitions (e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO"])
    description?: string; // GCal event description — maps to ItemInterface.notes
    /** True when GCal returned `start.date` (no time) — `timeStart`/`timeEnd` are then `YYYY-MM-DD`. */
    allDay?: boolean;
    /** GCal organizer of the event. Server-overwrites local on every inbound pull. */
    organizer?: GCalPerson;
    /** GCal creator (often equals organizer). Server-overwrites local on every inbound pull. */
    creator?: GCalPerson;
    /** Attendees, sorted by email for stable equality. Server-overwrites local on every inbound pull. */
    attendees?: GCalAttendee[];
    /** Denormalized from the `self` attendee's responseStatus. RSVP is the one local-write exception. */
    responseStatus?: GCalResponseStatus;
    /** GCal event type — usually `'default'`; outOfOffice/focusTime/workingLocation/fromGmail are special. */
    eventType?: GCalEventType;
    /** Conferencing join URL (Meet hangoutLink or conferenceData video entry point). GCal-owned; read-only. */
    meetingLink?: string;
    /** Free-text / physical location from the GCal `location` field. GCal-owned; read-only. */
    location?: string;
    /** Canonical Google Calendar event URL (`htmlLink`); opens the event in the GCal UI. GCal-owned; read-only. */
    htmlLink?: string;
}

/**
 * Result of a single-event create. `htmlLink` is the GCal-owned deep link into the Google Calendar
 * UI, captured from the insert response — the only chance to learn it for app-created events,
 * since the own-echo guard suppresses the inbound webhook report that would otherwise carry it
 * and incremental syncs never re-report an unchanged event.
 */
export interface CreatedCalendarEvent {
    eventId: string;
    htmlLink?: string;
}

export interface CalendarProvider {
    /** Fetches the IANA timezone of a calendar from the provider (e.g. "Asia/Jerusalem"). */
    getCalendarTimeZone(calendarId: string): Promise<string>;
    /** When `options.id` is provided, GCal uses it as the event's id; on duplicate (409), the caller treats it as already-linked. */
    createRecurringEvent(routine: RoutineInterface, calendarId: string, timeZone: string, options?: { id?: string }): Promise<string>; // returns eventId
    updateRecurringEvent(eventId: string, routine: RoutineInterface, calendarId: string, timeZone: string): Promise<void>;
    deleteRecurringEvent(eventId: string, calendarId: string): Promise<void>;
    /**
     * Caps an existing recurring series with UNTIL=<untilDate> via provider's update-series primitive,
     * keeping the eventId stable so past occurrences remain intact. Used by the app-side routine pause
     * gesture to stop a GCal master from producing future occurrences without deleting the series.
     * @param untilDate RRULE-formatted UNTIL value (e.g. "20260423T235959Z" — UTC, no separators).
     */
    capRecurringEvent(eventId: string, untilDate: string, calendarId: string, timeZone: string): Promise<void>;
    listCalendars(): Promise<Array<{ id: string; name: string; primary: boolean; accessRole: string }>>;
    /** @param since ISO datetime string — only exceptions after this point are returned */
    getExceptions(eventId: string, calendarId: string, since: string, masterContent?: MasterContent): Promise<GCalException[]>;
    /** Fetches all events (including cancelled) within the given time window. */
    listEvents(calendarId: string, since: string, until: string): Promise<GCalEvent[]>;
    /**
     * Fetches a single event by id, regardless of its time or modification state — the active-relink
     * sweep uses this to resolve `lastKnownCalendarEventId` markers that a full sync's `timeMin`
     * window or an incremental syncToken would never surface. Returns the event verbatim (including
     * `status: 'cancelled'` tombstones), or `null` when the provider reports it gone (404/410).
     */
    getEvent(calendarId: string, eventId: string): Promise<GCalEvent | null>;
    /** Fetches only events changed since the last sync using Google's syncToken. Throws SyncTokenInvalidError on 410 Gone. */
    listEventsIncremental(calendarId: string, syncToken: string): Promise<EventSyncResult>;
    /** Fetches all future events from timeMin onwards and returns a syncToken for subsequent incremental syncs. */
    listEventsFull(calendarId: string, timeMin: string): Promise<EventSyncResult>;
    /** Registers a push notification channel for calendar events. Returns Google's resourceId and expiration datetime. */
    watchEvents(calendarId: string, webhookUrl: string, channelId: string): Promise<{ resourceId: string; expiration: string }>;
    /** Stops a previously registered push notification channel. */
    stopWatch(channelId: string, resourceId: string): Promise<void>;
    /**
     * Creates a single (non-recurring) event. Returns the event ID plus the event's `htmlLink`
     * when the provider reports one — captured at create time because the own-echo guard
     * suppresses the inbound webhook report that would otherwise deliver it.
     * When `options.id` is provided, GCal uses it as the event's id; on duplicate (409), the caller treats it as already-linked.
     * When `event.allDay` is true, `timeStart`/`timeEnd` are `YYYY-MM-DD` strings and the provider
     * emits `{ date }` (no `timeZone`); GCal preserves its exclusive-end convention as-is.
     * When `event.attendees` is provided, the full array is sent verbatim — this is the second
     * local-write exception to the GCal-owned policy, alongside RSVP.
     * `options.sendUpdates`: defaults to `'none'` when unspecified, preserving silent-create
     * behavior for paths that don't yet forward the user's SendUpdatesDialog choice.
     */
    createEvent(
        calendarId: string,
        event: { title: string; timeStart: string; timeEnd: string; description?: string; allDay?: boolean; attendees?: GCalAttendee[] },
        timeZone: string,
        options?: { id?: string; sendUpdates?: 'all' | 'none' },
    ): Promise<CreatedCalendarEvent>;
    /**
     * Updates fields on an existing single event. `colorId` semantics: `undefined` leaves the
     * existing colorId untouched; `null` clears it (resets to the calendar's default color);
     * a string sets it to that palette ID.
     * When `updates.allDay` is true, any provided `timeStart`/`timeEnd` strings are emitted as
     * `{ date }` (no `timeZone`); otherwise as `{ dateTime, timeZone }`.
     * When `updates.attendees` is provided, the full array is sent verbatim.
     * `options.sendUpdates`: defaults to `'none'`.
     */
    updateEvent(
        calendarId: string,
        eventId: string,
        updates: {
            title?: string;
            timeStart?: string;
            timeEnd?: string;
            description?: string;
            colorId?: string | null;
            allDay?: boolean;
            attendees?: GCalAttendee[];
        },
        timeZone: string,
        options?: { sendUpdates?: 'all' | 'none' },
    ): Promise<void>;
    /**
     * Overrides a single instance of a recurring event series. The original instance is located
     * by `originalDate` (the YYYY-MM-DD the rrule originally generated). Implementations typically
     * resolve the instance-specific event ID via the provider's instances list, then patch it —
     * creating a single-instance override without affecting other occurrences.
     * Used for matrix cases A2/A3 (per-instance time/title/notes edit on a routine-managed series)
     * and A8 (routine-generated item marked done — apply title marker + sage colorId).
     * `colorId` semantics match `updateEvent`: `undefined` leaves it untouched, `null` clears it.
     * `allDay`/`attendees`/`options.sendUpdates` semantics also match `updateEvent`.
     * `options.instanceEventId`: when the caller already holds the GCal instance id (e.g. an item's
     * `calendarInstanceEventId`), pass it to patch that occurrence directly and skip the live
     * instances lookup — more reliable for already-modified instances and avoids a round-trip.
     */
    updateRecurringInstance(
        masterEventId: string,
        originalDate: string,
        updates: {
            title?: string;
            timeStart?: string;
            timeEnd?: string;
            description?: string;
            colorId?: string | null;
            allDay?: boolean;
            attendees?: GCalAttendee[];
        },
        calendarId: string,
        timeZone: string,
        options?: { sendUpdates?: 'all' | 'none'; instanceEventId?: string },
    ): Promise<void>;
    /**
     * Cancels a single instance of a recurring event series without affecting other occurrences.
     * The instance is located by `originalDate` (the YYYY-MM-DD the rrule originally generated),
     * then patched to `status: cancelled`. Used for matrix case A4 (trash a single instance of a
     * routine-managed series — equivalent to a `skipped` routineException).
     * `options.instanceEventId`: same as `updateRecurringInstance` — patch the known occurrence
     * directly and skip the live instances lookup.
     */
    cancelRecurringInstance(masterEventId: string, originalDate: string, calendarId: string, options?: { instanceEventId?: string }): Promise<void>;
    /** Deletes (cancels) a single event. */
    deleteEvent(calendarId: string, eventId: string): Promise<void>;
    /**
     * Returns the authenticated Google account's email — used by the RSVP endpoint to locate the
     * self-attendee entry (GCal's `attendees[].self` flag is only reliable on inbound payloads).
     * Implementations should cache the result per-instance to avoid repeated userinfo round-trips.
     */
    getMyEmail(): Promise<string>;
    /**
     * Patches the attendees array on a single event. Used by the RSVP fast-path so a Decline click
     * sends one PATCH instead of a full `events.update`. `sendUpdates` defaults to `'none'` to
     * preserve silent behavior for callers that don't yet forward the user's choice.
     */
    patchEventAttendees(calendarId: string, eventId: string, attendees: GCalAttendee[], options?: { sendUpdates?: 'all' | 'none' }): Promise<void>;
}
