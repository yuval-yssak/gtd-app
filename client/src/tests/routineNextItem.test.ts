import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { describeNextItemDate, findRoutineNextItem } from '../lib/routineNextItem';
import type { StoredItem, StoredRoutine } from '../types/MyDB';

const NOW = dayjs('2026-07-02T12:00:00.000Z');

function makeRoutine(overrides: Partial<StoredRoutine> = {}): StoredRoutine {
    return {
        _id: 'routine1',
        userId: 'user1',
        title: 'My routine',
        routineType: 'nextAction',
        rrule: 'FREQ=DAILY',
        template: {},
        active: true,
        createdTs: '2026-01-01T00:00:00.000Z',
        updatedTs: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

function makeItem(overrides: Partial<StoredItem> & Pick<StoredItem, '_id'>): StoredItem {
    return {
        userId: 'user1',
        status: 'nextAction',
        title: `item-${overrides._id}`,
        routineId: 'routine1',
        createdTs: '2026-06-01T00:00:00.000Z',
        updatedTs: '2026-06-01T00:00:00.000Z',
        ...overrides,
    };
}

describe('findRoutineNextItem — nextAction routines', () => {
    it('picks the earliest open item even when overdue', () => {
        const overdue = makeItem({ _id: 'i1', expectedBy: '2026-06-20' });
        const future = makeItem({ _id: 'i2', expectedBy: '2026-07-10' });
        const result = findRoutineNextItem(makeRoutine(), [future, overdue], NOW);
        expect(result.item?._id).toBe('i1');
    });

    it('ignores done and trashed items', () => {
        const done = makeItem({ _id: 'i1', status: 'done', expectedBy: '2026-06-20' });
        const trashed = makeItem({ _id: 'i2', status: 'trash', expectedBy: '2026-06-21' });
        const open = makeItem({ _id: 'i3', expectedBy: '2026-07-10' });
        const result = findRoutineNextItem(makeRoutine(), [done, trashed, open], NOW);
        expect(result.item?._id).toBe('i3');
    });

    it('compares date-only expectedBy against full ISO createdTs correctly (ISO-8601 prefix ordering)', () => {
        // The sort key mixes YYYY-MM-DD (expectedBy) with ISO datetimes (createdTs fallback);
        // lexical comparison is valid because ISO-8601 sorts by prefix.
        const dateOnly = makeItem({ _id: 'i1', expectedBy: '2026-05-01' });
        const datetimeOnly = makeItem({ _id: 'i2', createdTs: '2026-06-15T08:00:00.000Z' });
        const result = findRoutineNextItem(makeRoutine(), [datetimeOnly, dateOnly], NOW);
        expect(result.item?._id).toBe('i1');
    });

    it('ignores items belonging to other routines', () => {
        const other = makeItem({ _id: 'i1', routineId: 'someOtherRoutine', expectedBy: '2026-06-01' });
        const result = findRoutineNextItem(makeRoutine(), [other], NOW);
        expect(result.item).toBeNull();
    });

    it('reports "not generated yet" for an active routine with no open items', () => {
        const result = findRoutineNextItem(makeRoutine(), [], NOW);
        expect(result.item).toBeNull();
        if (result.item) throw new Error('expected no item');
        expect(result.reason).toBe('No upcoming item yet');
    });

    it('reports the paused reason for an inactive routine', () => {
        const result = findRoutineNextItem(makeRoutine({ active: false }), [], NOW);
        if (result.item) throw new Error('expected no item');
        expect(result.reason).toBe('No upcoming item — routine is paused');
    });
});

describe('findRoutineNextItem — calendar routines', () => {
    const calendarRoutine = makeRoutine({ routineType: 'calendar' });

    function makeCalendarItem(id: string, timeStart: string, timeEnd: string): StoredItem {
        return makeItem({ _id: id, status: 'calendar', timeStart, timeEnd });
    }

    it('picks the next instance whose end has not passed, skipping fully past ones', () => {
        const past = makeCalendarItem('i1', '2026-07-01T09:00:00.000Z', '2026-07-01T10:00:00.000Z');
        const future = makeCalendarItem('i2', '2026-07-03T09:00:00.000Z', '2026-07-03T10:00:00.000Z');
        const later = makeCalendarItem('i3', '2026-07-05T09:00:00.000Z', '2026-07-05T10:00:00.000Z');
        const result = findRoutineNextItem(calendarRoutine, [later, past, future], NOW);
        expect(result.item?._id).toBe('i2');
    });

    it('counts an ongoing instance as next', () => {
        const ongoing = makeCalendarItem('i1', '2026-07-02T11:00:00.000Z', '2026-07-02T13:00:00.000Z');
        const future = makeCalendarItem('i2', '2026-07-03T09:00:00.000Z', '2026-07-03T10:00:00.000Z');
        const result = findRoutineNextItem(calendarRoutine, [future, ongoing], NOW);
        expect(result.item?._id).toBe('i1');
    });

    it('treats the exclusive all-day end date as already over at midnight', () => {
        // All-day July 1 stores timeEnd 2026-07-02 (exclusive) — by noon July 2 it has passed.
        const allDayPast = makeItem({ _id: 'i1', status: 'calendar', timeStart: '2026-07-01', timeEnd: '2026-07-02', allDay: true });
        const result = findRoutineNextItem(calendarRoutine, [allDayPast], NOW);
        expect(result.item).toBeNull();
    });

    it('reports no upcoming item when all instances are past', () => {
        const past = makeCalendarItem('i1', '2026-06-01T09:00:00.000Z', '2026-06-01T10:00:00.000Z');
        const result = findRoutineNextItem(calendarRoutine, [past], NOW);
        if (result.item) throw new Error('expected no item');
        expect(result.reason).toBe('No upcoming item yet');
    });
});

describe('describeNextItemDate', () => {
    it('formats timed calendar items with date and time', () => {
        const item = makeItem({ _id: 'i1', status: 'calendar', timeStart: '2026-07-03T09:30:00.000Z', timeEnd: '2026-07-03T10:00:00.000Z' });
        expect(describeNextItemDate(item)).toBe(dayjs('2026-07-03T09:30:00.000Z').format('ddd, MMM D HH:mm'));
    });

    it('formats all-day items without a time', () => {
        const item = makeItem({ _id: 'i1', status: 'calendar', timeStart: '2026-07-03', timeEnd: '2026-07-04', allDay: true });
        expect(describeNextItemDate(item)).toBe('Fri, Jul 3');
    });

    it('formats next actions by due date, then tickler date, then blank', () => {
        expect(describeNextItemDate(makeItem({ _id: 'i1', expectedBy: '2026-07-04' }))).toBe('due Jul 4');
        expect(describeNextItemDate(makeItem({ _id: 'i2', ignoreBefore: '2026-07-06' }))).toBe('hidden until Jul 6');
        expect(describeNextItemDate(makeItem({ _id: 'i3' }))).toBe('');
    });
});
