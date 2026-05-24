import { describe, expect, it } from 'vitest';
import { itemToCalendarForm } from '../components/itemEditor/ItemEditorBody';
import type { StoredItem } from '../types/MyDB';

function makeItem(overrides: Partial<StoredItem>): StoredItem {
    return {
        _id: 'i1',
        userId: 'u1',
        status: 'calendar',
        title: 'evt',
        createdTs: '2026-05-01T00:00:00.000Z',
        updatedTs: '2026-05-01T00:00:00.000Z',
        ...overrides,
    };
}

describe('itemToCalendarForm', () => {
    it('decodes a stored all-day single-day item: timeEnd = timeStart + 1 day → form endDate is blank', () => {
        const item = makeItem({ allDay: true, timeStart: '2026-05-27', timeEnd: '2026-05-28' });
        const form = itemToCalendarForm(item);
        expect(form.allDay).toBe(true);
        expect(form.date).toBe('2026-05-27');
        expect(form.endDate).toBe('');
        expect(form.startTime).toBe('');
        expect(form.endTime).toBe('');
    });

    it('decodes a stored all-day multi-day item: form endDate is the +1-day-exclusive minus one day', () => {
        // GCal exclusive end May 30 → inclusive form endDate May 29
        const item = makeItem({ allDay: true, timeStart: '2026-05-27', timeEnd: '2026-05-30' });
        const form = itemToCalendarForm(item);
        expect(form.allDay).toBe(true);
        expect(form.date).toBe('2026-05-27');
        expect(form.endDate).toBe('2026-05-29');
    });

    it('decodes a timed item into HH:mm strings with allDay false', () => {
        const item = makeItem({ timeStart: '2026-05-27T09:00:00.000Z', timeEnd: '2026-05-27T10:00:00.000Z' });
        const form = itemToCalendarForm(item);
        expect(form.allDay).toBe(false);
        expect(form.date).toBe('2026-05-27');
        expect(form.startTime).not.toBe('');
        expect(form.endTime).not.toBe('');
        expect(form.endDate).toBe('');
    });

    it('returns emptyCalendar for an item with no timeStart', () => {
        // Omit timeStart entirely rather than pass undefined — exactOptionalPropertyTypes refuses
        // explicit-undefined on optional fields. The behavior under test (no timeStart → emptyCalendar)
        // matches the production shape exactly.
        const item = makeItem({});
        const form = itemToCalendarForm(item);
        expect(form.date).toBe('');
        expect(form.allDay).toBe(false);
    });

    it('round-trip: an all-day item with no timeEnd falls back to endDate empty', () => {
        const item = makeItem({ allDay: true, timeStart: '2026-05-27' });
        const form = itemToCalendarForm(item);
        expect(form.allDay).toBe(true);
        expect(form.date).toBe('2026-05-27');
        expect(form.endDate).toBe('');
    });
});
