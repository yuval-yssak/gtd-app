import { describe, expect, it } from 'vitest';
import type { MasterContent } from '../calendarProviders/CalendarProvider.js';
import { buildModifiedException, parseGCalEvents } from '../calendarProviders/GoogleCalendarProvider.js';

// Mirrors the relevant subset of googleapis' calendar_v3.Schema$Event — the parser accepts
// arbitrary records and narrows internally, so tests just hand it the same shape Google does.
type RawEvent = Record<string, unknown>;

describe('parseGCalEvents — all-day events', () => {
    it('emits an all-day single-day event with raw YYYY-MM-DD start/end strings', () => {
        const raw: RawEvent = {
            id: 'evt-allday-1',
            summary: 'Memorial Day',
            start: { date: '2026-05-27' },
            end: { date: '2026-05-28' }, // GCal's exclusive end
            updated: '2026-05-20T10:00:00Z',
            status: 'confirmed',
        };

        const result = parseGCalEvents([raw]);

        expect(result).toHaveLength(1);
        const [event] = result;
        if (!event) throw new Error('expected one event');
        expect(event.allDay).toBe(true);
        expect(event.timeStart).toBe('2026-05-27');
        expect(event.timeEnd).toBe('2026-05-28');
        expect(event.status).toBe('confirmed');
    });

    it('preserves the exclusive +3-day end for a multi-day all-day event', () => {
        const raw: RawEvent = {
            id: 'evt-allday-multi',
            summary: 'Offsite',
            start: { date: '2026-06-01' },
            end: { date: '2026-06-04' }, // exclusive — last covered day is 2026-06-03
            updated: '2026-05-25T08:00:00Z',
            status: 'confirmed',
        };

        const result = parseGCalEvents([raw]);

        const [event] = result;
        if (!event) throw new Error('expected one event');
        expect(event.allDay).toBe(true);
        expect(event.timeStart).toBe('2026-06-01');
        expect(event.timeEnd).toBe('2026-06-04');
    });

    it('omits allDay on timed events so consumers can use truthy-checks', () => {
        const raw: RawEvent = {
            id: 'evt-timed',
            summary: 'Standup',
            start: { dateTime: '2026-05-27T09:00:00Z' },
            end: { dateTime: '2026-05-27T09:30:00Z' },
            updated: '2026-05-20T10:00:00Z',
            status: 'confirmed',
        };

        const [event] = parseGCalEvents([raw]);
        if (!event) throw new Error('expected one event');
        expect(event.allDay).toBeUndefined();
    });
});

describe('parseGCalEvents — meeting metadata', () => {
    it('populates organizer, creator, attendees, responseStatus, and eventType on a timed event', () => {
        const raw: RawEvent = {
            id: 'evt-meeting',
            summary: 'Design review',
            start: { dateTime: '2026-05-28T14:00:00Z' },
            end: { dateTime: '2026-05-28T15:00:00Z' },
            updated: '2026-05-25T10:00:00Z',
            status: 'confirmed',
            eventType: 'default',
            organizer: { email: 'alice@example.com', displayName: 'Alice' },
            creator: { email: 'alice@example.com', displayName: 'Alice' },
            attendees: [
                { email: 'carol@example.com', displayName: 'Carol', responseStatus: 'declined' },
                { email: 'alice@example.com', displayName: 'Alice', responseStatus: 'accepted', organizer: true },
                { email: 'bob@example.com', displayName: 'Bob', responseStatus: 'accepted', self: true },
            ],
        };

        const [event] = parseGCalEvents([raw]);
        if (!event) throw new Error('expected one event');

        expect(event.organizer).toEqual({ email: 'alice@example.com', displayName: 'Alice' });
        expect(event.creator).toEqual({ email: 'alice@example.com', displayName: 'Alice' });
        expect(event.eventType).toBe('default');
        // Sort by email is what stabilizes equality across pulls.
        expect(event.attendees?.map((a) => a.email)).toEqual(['alice@example.com', 'bob@example.com', 'carol@example.com']);
        // responseStatus is denormalized from the self attendee — Bob in this case.
        expect(event.responseStatus).toBe('accepted');
    });

    it('drops attendees lacking an email (e.g. calendar resource entries) while keeping the rest', () => {
        const raw: RawEvent = {
            id: 'evt-resource',
            summary: 'Boardroom sync',
            start: { dateTime: '2026-05-29T16:00:00Z' },
            end: { dateTime: '2026-05-29T17:00:00Z' },
            updated: '2026-05-25T10:00:00Z',
            status: 'confirmed',
            attendees: [
                { displayName: 'Boardroom A', responseStatus: 'accepted' }, // resource, no email
                { email: 'alice@example.com', responseStatus: 'accepted', self: true },
            ],
        };

        const [event] = parseGCalEvents([raw]);
        if (!event) throw new Error('expected one event');
        expect(event.attendees).toHaveLength(1);
        const [attendee] = event.attendees ?? [];
        if (!attendee) throw new Error('expected one attendee');
        expect(attendee.email).toBe('alice@example.com');
        expect(event.responseStatus).toBe('accepted');
    });

    it('defaults attendee responseStatus to needsAction when GCal omits it', () => {
        const raw: RawEvent = {
            id: 'evt-pending',
            summary: 'Lunch invite',
            start: { dateTime: '2026-05-30T12:00:00Z' },
            end: { dateTime: '2026-05-30T13:00:00Z' },
            updated: '2026-05-25T10:00:00Z',
            status: 'confirmed',
            attendees: [{ email: 'alice@example.com' }],
        };

        const [event] = parseGCalEvents([raw]);
        if (!event) throw new Error('expected one event');
        const [attendee] = event.attendees ?? [];
        if (!attendee) throw new Error('expected one attendee');
        expect(attendee.responseStatus).toBe('needsAction');
    });

    it('extracts eventType: outOfOffice with attendees undefined when there are none', () => {
        const raw: RawEvent = {
            id: 'evt-ooo',
            summary: 'OOO',
            start: { dateTime: '2026-06-05T09:00:00Z' },
            end: { dateTime: '2026-06-05T17:00:00Z' },
            updated: '2026-06-04T08:00:00Z',
            status: 'confirmed',
            eventType: 'outOfOffice',
        };

        const [event] = parseGCalEvents([raw]);
        if (!event) throw new Error('expected one event');
        expect(event.eventType).toBe('outOfOffice');
        expect(event.attendees).toBeUndefined();
        expect(event.responseStatus).toBeUndefined();
    });

    it('leaves responseStatus undefined when no attendee is flagged self', () => {
        const raw: RawEvent = {
            id: 'evt-no-self',
            summary: 'Public event',
            start: { dateTime: '2026-06-10T10:00:00Z' },
            end: { dateTime: '2026-06-10T11:00:00Z' },
            updated: '2026-06-05T10:00:00Z',
            status: 'confirmed',
            attendees: [
                { email: 'carol@example.com', responseStatus: 'accepted' },
                { email: 'dan@example.com', responseStatus: 'declined' },
            ],
        };

        const [event] = parseGCalEvents([raw]);
        if (!event) throw new Error('expected one event');
        expect(event.responseStatus).toBeUndefined();
        expect(event.attendees).toHaveLength(2);
    });
});

describe('buildModifiedException — per-instance override emission', () => {
    const baseMaster: MasterContent = {
        title: 'Weekly 1:1',
        description: '',
        organizer: { email: 'organizer@example.com', displayName: 'Org' },
        attendees: [
            { email: 'alice@example.com', responseStatus: 'accepted' },
            { email: 'bob@example.com', responseStatus: 'accepted' },
        ],
        eventType: 'default',
    };

    function buildInstance(overrides: Record<string, unknown> = {}): RawEvent {
        return {
            id: 'gcal-inst-1_20260520T120000Z',
            summary: 'Weekly 1:1',
            start: { dateTime: '2026-05-20T12:00:00Z' },
            end: { dateTime: '2026-05-20T12:30:00Z' },
            originalStartTime: { dateTime: '2026-05-20T12:00:00Z' },
            description: '',
            organizer: { email: 'organizer@example.com', displayName: 'Org' },
            attendees: [
                { email: 'alice@example.com', responseStatus: 'accepted' },
                { email: 'bob@example.com', responseStatus: 'accepted' },
            ],
            eventType: 'default',
            ...overrides,
        };
    }

    it('returns an empty array when the instance matches the master in every field (RFC 5545 inheritance)', () => {
        const result = buildModifiedException(buildInstance(), '2026-05-20', baseMaster);
        expect(result).toEqual([]);
    });

    it('emits attendees on the exception when the instance has an extra attendee', () => {
        const result = buildModifiedException(
            buildInstance({
                attendees: [
                    { email: 'alice@example.com', responseStatus: 'accepted' },
                    { email: 'bob@example.com', responseStatus: 'accepted' },
                    { email: 'carol@example.com', responseStatus: 'needsAction' },
                ],
            }),
            '2026-05-20',
            baseMaster,
        );
        expect(result).toHaveLength(1);
        const [ex] = result;
        if (!ex) throw new Error('expected one exception');
        expect(ex.attendees).toHaveLength(3);
        expect(ex.attendees?.map((a) => a.email)).toEqual(['alice@example.com', 'bob@example.com', 'carol@example.com']);
    });

    it('emits attendees on the exception when the instance has fewer attendees', () => {
        const result = buildModifiedException(
            buildInstance({
                attendees: [{ email: 'alice@example.com', responseStatus: 'accepted' }],
            }),
            '2026-05-20',
            baseMaster,
        );
        expect(result).toHaveLength(1);
        const [ex] = result;
        if (!ex) throw new Error('expected one exception');
        expect(ex.attendees).toHaveLength(1);
        expect(ex.attendees?.[0]?.email).toBe('alice@example.com');
    });

    it('emits attendees when one attendee responseStatus differs (declined)', () => {
        const result = buildModifiedException(
            buildInstance({
                attendees: [
                    { email: 'alice@example.com', responseStatus: 'declined' },
                    { email: 'bob@example.com', responseStatus: 'accepted' },
                ],
            }),
            '2026-05-20',
            baseMaster,
        );
        expect(result).toHaveLength(1);
        const [ex] = result;
        if (!ex) throw new Error('expected one exception');
        expect(ex.attendees?.find((a) => a.email === 'alice@example.com')?.responseStatus).toBe('declined');
    });

    it('emits eventType when the instance type diverges from the master', () => {
        const result = buildModifiedException(buildInstance({ eventType: 'focusTime' }), '2026-05-20', baseMaster);
        expect(result).toHaveLength(1);
        const [ex] = result;
        if (!ex) throw new Error('expected one exception');
        expect(ex.eventType).toBe('focusTime');
    });

    it('omits inherited keys on a title-only override (other GCal-owned fields stay absent)', () => {
        const result = buildModifiedException(buildInstance({ summary: 'Special title — this date' }), '2026-05-20', baseMaster);
        expect(result).toHaveLength(1);
        const [ex] = result;
        if (!ex) throw new Error('expected one exception');
        expect(ex.title).toBe('Special title — this date');
        expect(ex.attendees).toBeUndefined();
        expect(ex.organizer).toBeUndefined();
        expect(ex.eventType).toBeUndefined();
    });
});

describe('parseGCalEvents — cancelled events', () => {
    it('emits a sparse cancelled event without organizer/creator/attendees even if GCal returned them', () => {
        const raw: RawEvent = {
            id: 'evt-cancelled',
            status: 'cancelled',
            // Cancelled events in incremental sync may carry stale metadata — we ignore it
            // because cancellation is the trash trigger; attendee state isn't meaningful anymore.
            organizer: { email: 'alice@example.com' },
            creator: { email: 'alice@example.com' },
            attendees: [{ email: 'bob@example.com', responseStatus: 'accepted', self: true }],
            eventType: 'default',
        };

        const [event] = parseGCalEvents([raw]);
        if (!event) throw new Error('expected one event');
        expect(event.status).toBe('cancelled');
        expect(event.organizer).toBeUndefined();
        expect(event.creator).toBeUndefined();
        expect(event.attendees).toBeUndefined();
        expect(event.responseStatus).toBeUndefined();
        expect(event.eventType).toBeUndefined();
    });
});
