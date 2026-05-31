/**
 * Unit tests for the calendar route's grouping + sort helpers. Render-free coverage — see
 * vitest.config.ts (no jsdom). The route itself just maps over the returned structure.
 */
import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { compareWithinDay, groupCalendarItemsByDay, groupingKeyFor, isMultiDayAllDay, NO_DATE_KEY } from '../components/calendarRouteSort';
import type { StoredItem } from '../types/MyDB';

function makeItem(overrides: Partial<StoredItem> = {}): StoredItem {
    return {
        _id: overrides._id ?? Math.random().toString(36).slice(2),
        userId: 'user-1',
        status: 'calendar',
        title: overrides.title ?? 'Untitled',
        createdTs: '2026-05-23T00:00:00.000Z',
        updatedTs: '2026-05-23T00:00:00.000Z',
        ...overrides,
    };
}

describe('groupingKeyFor', () => {
    it('returns the No-date sentinel when timeStart is missing', () => {
        expect(groupingKeyFor(makeItem())).toBe(NO_DATE_KEY);
    });

    it('returns the verbatim YYYY-MM-DD for all-day items (no tz application)', () => {
        // Regression: dayjs(date).tz(...) would shift "May 23" in negative-offset zones; for an all-day
        // event the date is the calendar owner's local date and must be preserved character-for-character.
        const item = makeItem({ allDay: true, timeStart: '2026-05-23', timeEnd: '2026-05-24' });
        expect(groupingKeyFor(item)).toBe('2026-05-23');
    });

    it('formats a timed timeStart via dayjs YYYY-MM-DD', () => {
        const item = makeItem({ timeStart: '2026-05-23T15:00:00.000Z' });
        // The exact date may depend on machine tz; assert it parses to *some* YYYY-MM-DD shape.
        expect(groupingKeyFor(item)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
});

describe('compareWithinDay', () => {
    it('sorts all-day events before timed events', () => {
        const allDay = makeItem({ allDay: true, timeStart: '2026-05-23', title: 'Zebra' });
        const timed = makeItem({ timeStart: '2026-05-23T08:00:00.000Z', title: 'Apple' });
        expect(compareWithinDay(allDay, timed)).toBeLessThan(0);
        expect(compareWithinDay(timed, allDay)).toBeGreaterThan(0);
    });

    it('sorts two all-day events alphabetically by title', () => {
        const a = makeItem({ allDay: true, timeStart: '2026-05-23', title: 'Apple' });
        const z = makeItem({ allDay: true, timeStart: '2026-05-23', title: 'Zebra' });
        expect(compareWithinDay(a, z)).toBeLessThan(0);
        expect(compareWithinDay(z, a)).toBeGreaterThan(0);
    });

    it('sorts two timed events by timeStart', () => {
        const morning = makeItem({ timeStart: '2026-05-23T08:00:00.000Z' });
        const evening = makeItem({ timeStart: '2026-05-23T20:00:00.000Z' });
        expect(compareWithinDay(morning, evening)).toBeLessThan(0);
        expect(compareWithinDay(evening, morning)).toBeGreaterThan(0);
    });

    it('orders mixed UTC (…Z) and floating-local timeStart by parsed instant, not lexically', () => {
        // Regression (staging): a GCal-synced item stored as UTC `…Z` ("Marketplace for google meet")
        // and an in-app item stored as floating local time ("Get wipes and clementine juice") landed
        // in the same day, but the old comparator did a string localeCompare. Lexically `05:45…Z` sorts
        // before `08:30`, so the meet event rendered first even though — in any zone at/above UTC+3 —
        // its instant is the later one. The comparator must match the parsed-instant order regardless
        // of the machine's tz, so we derive the expected sign from dayjs rather than hardcoding it.
        const chore = makeItem({ _id: 'chore', timeStart: '2026-05-31T08:30:00', title: 'Get wipes' }); // floating local
        const meet = makeItem({ _id: 'meet', timeStart: '2026-05-31T05:45:00.000Z', title: 'Marketplace meet' }); // UTC
        const expectedSign = Math.sign(dayjs(chore.timeStart).valueOf() - dayjs(meet.timeStart).valueOf());
        // Sanity: the two timestamps are genuinely distinct instants (guards a degenerate 0-sign assertion).
        expect(expectedSign).not.toBe(0);
        expect(Math.sign(compareWithinDay(chore, meet))).toBe(expectedSign);
        expect(Math.sign(compareWithinDay(meet, chore))).toBe(-expectedSign);
    });
});

describe('groupCalendarItemsByDay', () => {
    it('groups items by their day-key and sorts the buckets chronologically', () => {
        const may23 = makeItem({ _id: 'a', timeStart: '2026-05-23T10:00:00.000Z' });
        const may24 = makeItem({ _id: 'b', timeStart: '2026-05-24T10:00:00.000Z' });
        const noDate = makeItem({ _id: 'c' });
        const result = groupCalendarItemsByDay([noDate, may24, may23]);
        const keys = Object.keys(result);
        const dateKeys = keys.filter((k) => k !== NO_DATE_KEY);
        expect(dateKeys).toEqual([...dateKeys].sort());
        // No-date sentinel pinned to the end.
        expect(keys[keys.length - 1]).toBe(NO_DATE_KEY);
    });

    it('within a day, places all-day first (alphabetical) then timed (by timeStart)', () => {
        const items: StoredItem[] = [
            makeItem({ _id: 't2', timeStart: '2026-05-23T20:00:00.000Z', title: 'Evening' }),
            makeItem({ _id: 'ad-z', allDay: true, timeStart: '2026-05-23', timeEnd: '2026-05-24', title: 'Zebra holiday' }),
            makeItem({ _id: 't1', timeStart: '2026-05-23T08:00:00.000Z', title: 'Morning' }),
            makeItem({ _id: 'ad-a', allDay: true, timeStart: '2026-05-23', timeEnd: '2026-05-24', title: 'Apple holiday' }),
        ];
        const grouped = groupCalendarItemsByDay(items);
        const bucket = grouped['2026-05-23'];
        if (!bucket) throw new Error('expected a 2026-05-23 bucket');
        const ids = bucket.map((i) => i._id);
        expect(ids).toEqual(['ad-a', 'ad-z', 't1', 't2']);
    });

    it('lists a multi-day all-day event only under its start date', () => {
        // 3-day all-day: 2026-05-23 inclusive through 2026-05-25 inclusive → GCal exclusive end 2026-05-26.
        const multi = makeItem({ _id: 'multi', allDay: true, timeStart: '2026-05-23', timeEnd: '2026-05-26', title: 'Conference' });
        const grouped = groupCalendarItemsByDay([multi]);
        expect(Object.keys(grouped)).toEqual(['2026-05-23']);
        expect(grouped['2026-05-23']?.length).toBe(1);
        // Specifically, the item must NOT appear under 05-24 or 05-25.
        expect(grouped['2026-05-24']).toBeUndefined();
        expect(grouped['2026-05-25']).toBeUndefined();
    });
});

describe('isMultiDayAllDay', () => {
    it('returns false for a timed event', () => {
        const item = makeItem({ timeStart: '2026-05-23T08:00:00.000Z', timeEnd: '2026-05-24T08:00:00.000Z' });
        expect(isMultiDayAllDay(item)).toBe(false);
    });

    it('returns false for a single-day all-day (end is start + 1 exclusive)', () => {
        const item = makeItem({ allDay: true, timeStart: '2026-05-23', timeEnd: '2026-05-24' });
        expect(isMultiDayAllDay(item)).toBe(false);
    });

    it('returns true for a 2-day all-day (end is start + 2 exclusive)', () => {
        const item = makeItem({ allDay: true, timeStart: '2026-05-23', timeEnd: '2026-05-25' });
        expect(isMultiDayAllDay(item)).toBe(true);
    });

    it('returns true for a 3-day all-day spanning a month boundary', () => {
        const item = makeItem({ allDay: true, timeStart: '2026-05-30', timeEnd: '2026-06-02' });
        expect(isMultiDayAllDay(item)).toBe(true);
    });

    it('returns false when timeEnd is missing', () => {
        const item = makeItem({ allDay: true, timeStart: '2026-05-23' });
        expect(isMultiDayAllDay(item)).toBe(false);
    });
});
