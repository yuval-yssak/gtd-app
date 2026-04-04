import type { RoutineInterface } from '../types/entities.js';

export interface GCalException {
    originalDate: string; // ISO date of the original rrule occurrence
    type: 'modified' | 'deleted';
    newTimeStart?: string; // ISO datetime — present when type === 'modified'
    newTimeEnd?: string;
    googleEventId?: string;
}

export interface GCalEvent {
    id: string;
    title: string;
    timeStart: string; // ISO datetime
    timeEnd: string; // ISO datetime
    updated: string; // ISO datetime — used for last-write-wins conflict resolution
    status: 'confirmed' | 'tentative' | 'cancelled';
    recurringEventId?: string; // set for instances that belong to a recurring series
}

export interface CalendarProvider {
    createRecurringEvent(routine: RoutineInterface, calendarId: string): Promise<string>; // returns eventId
    updateRecurringEvent(eventId: string, routine: RoutineInterface, calendarId: string): Promise<void>;
    deleteRecurringEvent(eventId: string, calendarId: string): Promise<void>;
    listCalendars(): Promise<Array<{ id: string; name: string }>>;
    /** @param since ISO datetime string — only exceptions after this point are returned */
    getExceptions(eventId: string, calendarId: string, since: string): Promise<GCalException[]>;
    /** Fetches all events (including cancelled) within the given time window. */
    listEvents(calendarId: string, since: string, until: string): Promise<GCalEvent[]>;
}
