import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { describeEventStart, startsOnFutureDay } from '../lib/futureDoneConfirm';
import type { StoredItem } from '../types/MyDB';
import { pinClockAt } from './pinClock';

// Local wall-clock times (no offset): the predicate compares calendar days in the device's zone.
const NOW = dayjs('2026-10-26T14:00:00');

function makeCalendarItem(overrides: Partial<StoredItem> = {}): StoredItem {
    return {
        _id: 'item1',
        userId: 'user1',
        status: 'calendar',
        title: 'Dentist',
        createdTs: '2026-10-01T00:00:00.000Z',
        updatedTs: '2026-10-01T00:00:00.000Z',
        ...overrides,
    };
}

function localIso(wallClock: string): string {
    return dayjs(wallClock).toISOString();
}

describe('startsOnFutureDay', () => {
    it('is true for a timed event starting tomorrow, even right after midnight', () => {
        expect(startsOnFutureDay(makeCalendarItem({ timeStart: localIso('2026-10-27T00:05:00') }), NOW)).toBe(true);
    });

    it('is false for a timed event later today', () => {
        expect(startsOnFutureDay(makeCalendarItem({ timeStart: localIso('2026-10-26T23:55:00') }), NOW)).toBe(false);
    });

    it('is false for a timed event earlier today or in the past', () => {
        expect(startsOnFutureDay(makeCalendarItem({ timeStart: localIso('2026-10-26T08:00:00') }), NOW)).toBe(false);
        expect(startsOnFutureDay(makeCalendarItem({ timeStart: localIso('2026-10-20T08:00:00') }), NOW)).toBe(false);
    });

    it('reads an all-day date as the local calendar date', () => {
        expect(startsOnFutureDay(makeCalendarItem({ allDay: true, timeStart: '2026-10-27', timeEnd: '2026-10-28' }), NOW)).toBe(true);
        expect(startsOnFutureDay(makeCalendarItem({ allDay: true, timeStart: '2026-10-26', timeEnd: '2026-10-27' }), NOW)).toBe(false);
    });

    it('is false for a multi-day all-day event that started today', () => {
        expect(startsOnFutureDay(makeCalendarItem({ allDay: true, timeStart: '2026-10-26', timeEnd: '2026-10-30' }), NOW)).toBe(false);
    });

    it('is false for a calendar item with no start', () => {
        expect(startsOnFutureDay(makeCalendarItem(), NOW)).toBe(false);
    });

    it('is false for an item that is not a calendar item', () => {
        expect(startsOnFutureDay(makeCalendarItem({ status: 'nextAction', timeStart: localIso('2026-10-28T09:00:00') }), NOW)).toBe(false);
    });
});

describe('describeEventStart', () => {
    // The year is omitted only for the current year, so the 2026 fixtures need a pinned 2026 clock.
    pinClockAt('2026-06-01T12:00:00');

    it('names the day and the local start time of a timed event', () => {
        expect(describeEventStart(makeCalendarItem({ timeStart: localIso('2026-10-27T09:30:00') }))).toBe('Tue, Oct 27 at 9:30 am');
    });

    it('names only the day of an all-day event', () => {
        expect(describeEventStart(makeCalendarItem({ allDay: true, timeStart: '2026-10-27', timeEnd: '2026-10-28' }))).toBe('Tue, Oct 27');
    });

    it('adds the year when the event is not in the current year', () => {
        expect(describeEventStart(makeCalendarItem({ timeStart: localIso('2027-01-05T09:30:00') }))).toBe('Tue, Jan 5, 2027 at 9:30 am');
        expect(describeEventStart(makeCalendarItem({ allDay: true, timeStart: '2027-01-05', timeEnd: '2027-01-06' }))).toBe('Tue, Jan 5, 2027');
    });
});
