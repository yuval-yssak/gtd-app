import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import {
    actionableOccurrence,
    collapsedOccurrences,
    formatOccurrenceRelative,
    formatOccurrenceWhen,
    occurrenceSummary,
    representativeEventItem,
    sortAnchorOccurrence,
} from '../components/weeklyReview/routineReviewCardLogic';
import type { StoredItem, StoredRoutine } from '../types/MyDB';

// The RoutineReviewCard's pure derivations: which items a collapsed routine entry stands for, the
// date headline it leads with (the very date the calendar stage sorted it by), and the projection
// that lets the routine reuse the one-off calendar components. Kept out of the renderer so the
// empty / singular / all-day / exception edges are pinned without a DOM.

function makeItem(overrides: Partial<StoredItem> & { _id: string }): StoredItem {
    return {
        userId: 'user-1',
        title: overrides._id,
        status: 'calendar',
        createdTs: '2026-01-01T00:00:00.000Z',
        updatedTs: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

function makeRoutine(overrides: Partial<StoredRoutine> & { _id: string }): StoredRoutine {
    return {
        userId: 'user-1',
        title: overrides._id,
        routineType: 'calendar',
        rrule: 'FREQ=WEEKLY;BYDAY=TH',
        template: {},
        active: true,
        createdTs: '2026-01-01T00:00:00.000Z',
        updatedTs: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

describe('collapsedOccurrences', () => {
    it('keeps only the routine own calendar items, sorted by timeStart, excluding modified exceptions', () => {
        const routine = makeRoutine({ _id: 'r1', routineExceptions: [{ date: '2026-09-03', type: 'modified', itemId: 'exc' }] });
        const items = [
            makeItem({ _id: 'later', routineId: 'r1', timeStart: '2026-09-10T18:00:00.000Z' }),
            makeItem({ _id: 'sooner', routineId: 'r1', timeStart: '2026-08-27T18:00:00.000Z' }),
            makeItem({ _id: 'exc', routineId: 'r1', timeStart: '2026-09-03T18:00:00.000Z' }),
            makeItem({ _id: 'foreign', routineId: 'r2', timeStart: '2026-09-01T18:00:00.000Z' }),
            makeItem({ _id: 'doneOne', routineId: 'r1', status: 'done', timeStart: '2026-08-20T18:00:00.000Z' }),
        ];
        expect(collapsedOccurrences(routine, items).map((item) => item._id)).toEqual(['sooner', 'later']);
    });
});

describe('sortAnchorOccurrence', () => {
    it('picks the earliest dated occurrence — the one the calendar stage ranked the entry by', () => {
        const occurrences = [makeItem({ _id: 'first', timeStart: '2026-09-06T12:00:00' }), makeItem({ _id: 'second', timeStart: '2026-11-15T12:00:00' })];
        expect(sortAnchorOccurrence(occurrences)?._id).toBe('first');
    });

    it('skips undated occurrences so the headline never falls back to a date-less item', () => {
        const occurrences = [makeItem({ _id: 'undated' }), makeItem({ _id: 'dated', timeStart: '2026-09-06T12:00:00' })];
        expect(sortAnchorOccurrence(occurrences)?._id).toBe('dated');
    });

    it('returns undefined for a series with nothing generated yet', () => {
        expect(sortAnchorOccurrence([])).toBeUndefined();
    });
});

describe('actionableOccurrence', () => {
    const calendarRoutine = makeRoutine({ _id: 'r1', routineType: 'calendar' });
    const now = dayjs('2026-09-13T09:00:00');

    it('is the soonest UPCOMING occurrence when the series still has one', () => {
        const past = makeItem({ _id: 'past', routineId: 'r1', timeStart: '2026-09-06T12:00:00', timeEnd: '2026-09-06T13:00:00' });
        const soon = makeItem({ _id: 'soon', routineId: 'r1', timeStart: '2026-09-20T12:00:00', timeEnd: '2026-09-20T13:00:00' });
        expect(actionableOccurrence(calendarRoutine, [past, soon], now)?._id).toBe('soon');
    });

    it('diverges from the sort anchor for an all-past series: the anchor positions, the LATEST one is completed', () => {
        // The card is ranked by its earliest occurrence, but "Mark done" must complete the same
        // event the routine page offers — otherwise the two surfaces finish different events.
        const earliest = makeItem({ _id: 'earliest', routineId: 'r1', timeStart: '2026-09-04T12:00:00', timeEnd: '2026-09-04T13:00:00' });
        const latest = makeItem({ _id: 'latest', routineId: 'r1', timeStart: '2026-09-11T12:00:00', timeEnd: '2026-09-11T13:00:00' });
        const occurrences = [earliest, latest];
        expect(sortAnchorOccurrence(occurrences)?._id).toBe('earliest');
        expect(actionableOccurrence(calendarRoutine, occurrences, now)?._id).toBe('latest');
    });

    it('is undefined when the series has no occurrences at all', () => {
        expect(actionableOccurrence(calendarRoutine, [], now)).toBeUndefined();
    });
});

describe('formatOccurrenceWhen', () => {
    it('uses the /calendar page h:mm a convention, not a locally-invented 24h format', () => {
        // Timezone-naive timeStart so the local-time formatting is deterministic.
        const occurrence = makeItem({ _id: 'o', timeStart: '2026-09-06T12:00:00', timeEnd: '2026-09-06T13:00:00' });
        expect(formatOccurrenceWhen(occurrence)).toBe('Sun, Sep 6 · 12:00 pm – 1:00 pm');
    });

    it('drops the time range for a single-day all-day occurrence', () => {
        const occurrence = makeItem({ _id: 'o', allDay: true, timeStart: '2026-09-06', timeEnd: '2026-09-07' });
        expect(formatOccurrenceWhen(occurrence)).toBe('Sun, Sep 6 · all day');
    });

    it('renders a multi-day all-day range against the INCLUSIVE end, not the GCal-exclusive one', () => {
        // GCal stores Sep 6–8 inclusive as timeEnd 2026-09-09 (exclusive).
        const occurrence = makeItem({ _id: 'o', allDay: true, timeStart: '2026-09-06', timeEnd: '2026-09-09' });
        expect(formatOccurrenceWhen(occurrence)).toBe('Sun, Sep 6 – Tue, Sep 8 · all day');
    });

    it('omits the end when the occurrence carries only a start', () => {
        expect(formatOccurrenceWhen(makeItem({ _id: 'o', timeStart: '2026-09-06T12:00:00' }))).toBe('Sun, Sep 6 · 12:00 pm');
    });

    it('is empty when there is no occurrence at all', () => {
        expect(formatOccurrenceWhen(undefined)).toBe('');
    });
});

describe('formatOccurrenceRelative', () => {
    it('says "today" rather than an hours-away phrase for a same-day occurrence', () => {
        const now = dayjs('2026-09-06T09:00:00');
        expect(formatOccurrenceRelative(makeItem({ _id: 'o', timeStart: '2026-09-06T12:00:00' }), now)).toBe('today');
    });

    it('renders a forward-looking cue for a future occurrence', () => {
        const now = dayjs('2026-09-06T12:00:00');
        expect(formatOccurrenceRelative(makeItem({ _id: 'o', timeStart: '2026-09-09T12:00:00' }), now)).toBe('in 3 days');
    });

    it('renders a past cue for an overdue occurrence', () => {
        const now = dayjs('2026-09-09T12:00:00');
        expect(formatOccurrenceRelative(makeItem({ _id: 'o', timeStart: '2026-09-06T12:00:00' }), now)).toBe('3 days ago');
    });

    it('compares all-day occurrences at DAY granularity, not against local midnight', () => {
        // A bare YYYY-MM-DD parses to local midnight, so a raw from(now) would read "in 15 hours".
        const now = dayjs('2026-09-06T09:00:00');
        const allDayTomorrow = makeItem({ _id: 'o', allDay: true, timeStart: '2026-09-07', timeEnd: '2026-09-08' });
        expect(formatOccurrenceRelative(allDayTomorrow, now)).toBe('in a day');
    });

    it('is empty when there is no occurrence at all', () => {
        expect(formatOccurrenceRelative(undefined)).toBe('');
    });
});

describe('occurrenceSummary', () => {
    it('degenerates gracefully to zero occurrences', () => {
        expect(occurrenceSummary([], undefined)).toBe('0 occurrences on the calendar');
    });

    it('uses the singular and adds no tail when the anchor is the only occurrence', () => {
        const only = makeItem({ _id: 'one', timeStart: '2026-09-03T18:00:00' });
        expect(occurrenceSummary([only], only)).toBe('1 occurrence on the calendar');
    });

    it('counts the remaining occurrences after the headline one', () => {
        const first = makeItem({ _id: 'a', timeStart: '2026-09-03T18:00:00' });
        const rest = [makeItem({ _id: 'b', timeStart: '2026-09-10T18:00:00' }), makeItem({ _id: 'c', timeStart: '2026-09-17T18:00:00' })];
        expect(occurrenceSummary([first, ...rest], first)).toBe('3 occurrences on the calendar · 2 more after this one');
    });
});

describe('representativeEventItem', () => {
    const routine = makeRoutine({
        _id: 'r1',
        organizer: { email: 'organizer@example.com' },
        creator: { email: 'creator@example.com' },
        attendees: [{ email: 'organizer@example.com', responseStatus: 'accepted', organizer: true }],
        responseStatus: 'accepted',
        htmlLink: 'https://calendar.google.com/master',
        location: 'Room 1',
        meetingLink: 'https://meet.google.com/master',
        calendarSyncConfigId: 'cfg-master',
    });

    it('projects the series master GCal metadata onto the occurrence so the shared components can render it', () => {
        const projected = representativeEventItem(routine, makeItem({ _id: 'o', timeStart: '2026-09-06T12:00:00' }));
        expect(projected?.organizer?.email).toBe('organizer@example.com');
        expect(projected?.creator?.email).toBe('creator@example.com');
        expect(projected?.attendees).toHaveLength(1);
        expect(projected?.htmlLink).toBe('https://calendar.google.com/master');
        expect(projected?.location).toBe('Room 1');
        expect(projected?.meetingLink).toBe('https://meet.google.com/master');
        expect(projected?.calendarSyncConfigId).toBe('cfg-master');
        // The occurrence's own identity is preserved — only the absent GCal mirrors are filled in.
        expect(projected?._id).toBe('o');
        expect(projected?.timeStart).toBe('2026-09-06T12:00:00');
    });

    it('lets the occurrence own values win, so a GCal-modified instance keeps its own details', () => {
        const occurrence = makeItem({
            _id: 'o',
            timeStart: '2026-09-06T12:00:00',
            attendees: [{ email: 'instance@example.com', responseStatus: 'declined' }],
            location: 'Room 2',
            htmlLink: 'https://calendar.google.com/instance',
        });
        const projected = representativeEventItem(routine, occurrence);
        const [attendee] = projected?.attendees ?? [];
        if (!attendee) throw new Error('expected the occurrence attendee to survive the projection');
        expect(attendee.email).toBe('instance@example.com');
        expect(projected?.location).toBe('Room 2');
        expect(projected?.htmlLink).toBe('https://calendar.google.com/instance');
        // Fields the occurrence lacks still fall back to the master.
        expect(projected?.meetingLink).toBe('https://meet.google.com/master');
    });

    it('returns undefined when the series has no occurrence to represent', () => {
        expect(representativeEventItem(routine, undefined)).toBeUndefined();
    });
});
