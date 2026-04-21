import type { RoutineInterface } from '../types/entities.js';

/** Result of an incremental or full event sync — includes events and the token for the next sync. */
export interface EventSyncResult {
    events: GCalEvent[];
    nextSyncToken: string;
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
}

/** Master event content passed to getExceptions() so it can detect content-only changes. */
export interface MasterContent {
    title: string;
    description: string;
}

export interface GCalEvent {
    id: string;
    title: string;
    timeStart: string; // ISO datetime
    timeEnd: string; // ISO datetime
    updated: string; // ISO datetime — used for last-write-wins conflict resolution
    status: 'confirmed' | 'tentative' | 'cancelled';
    recurringEventId?: string; // set for instances that belong to a recurring series
    recurrence?: string[]; // present on master recurring event definitions (e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO"])
    description?: string; // GCal event description — maps to ItemInterface.notes
}

export interface CalendarProvider {
    /** Fetches the IANA timezone of a calendar from the provider (e.g. "Asia/Jerusalem"). */
    getCalendarTimeZone(calendarId: string): Promise<string>;
    createRecurringEvent(routine: RoutineInterface, calendarId: string, timeZone: string): Promise<string>; // returns eventId
    updateRecurringEvent(eventId: string, routine: RoutineInterface, calendarId: string, timeZone: string): Promise<void>;
    deleteRecurringEvent(eventId: string, calendarId: string): Promise<void>;
    listCalendars(): Promise<Array<{ id: string; name: string }>>;
    /** @param since ISO datetime string — only exceptions after this point are returned */
    getExceptions(eventId: string, calendarId: string, since: string, masterContent?: MasterContent): Promise<GCalException[]>;
    /** Fetches all events (including cancelled) within the given time window. */
    listEvents(calendarId: string, since: string, until: string): Promise<GCalEvent[]>;
    /** Fetches only events changed since the last sync using Google's syncToken. Throws SyncTokenInvalidError on 410 Gone. */
    listEventsIncremental(calendarId: string, syncToken: string): Promise<EventSyncResult>;
    /** Fetches all future events from timeMin onwards and returns a syncToken for subsequent incremental syncs. */
    listEventsFull(calendarId: string, timeMin: string): Promise<EventSyncResult>;
    /** Registers a push notification channel for calendar events. Returns Google's resourceId and expiration datetime. */
    watchEvents(calendarId: string, webhookUrl: string, channelId: string): Promise<{ resourceId: string; expiration: string }>;
    /** Stops a previously registered push notification channel. */
    stopWatch(channelId: string, resourceId: string): Promise<void>;
    /** Creates a single (non-recurring) event. Returns the event ID. */
    createEvent(calendarId: string, event: { title: string; timeStart: string; timeEnd: string; description?: string }, timeZone: string): Promise<string>;
    /** Updates fields on an existing single event. */
    updateEvent(
        calendarId: string,
        eventId: string,
        updates: { title?: string; timeStart?: string; timeEnd?: string; description?: string },
        timeZone: string,
    ): Promise<void>;
    /**
     * Overrides a single instance of a recurring event series. The original instance is located
     * by `originalDate` (the YYYY-MM-DD the rrule originally generated). Implementations typically
     * resolve the instance-specific event ID via the provider's instances list, then patch it —
     * creating a single-instance override without affecting other occurrences.
     * Used for matrix cases A2/A3 (per-instance time/title/notes edit on a routine-managed series).
     */
    updateRecurringInstance(
        masterEventId: string,
        originalDate: string,
        updates: { title?: string; timeStart?: string; timeEnd?: string; description?: string },
        calendarId: string,
        timeZone: string,
    ): Promise<void>;
    /** Deletes (cancels) a single event. */
    deleteEvent(calendarId: string, eventId: string): Promise<void>;
}
