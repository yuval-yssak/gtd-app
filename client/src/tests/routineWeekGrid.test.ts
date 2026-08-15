import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { buildRoutineWeekGrid, fixedWeekdaysOf } from '../lib/routineWeekGrid';
import type { StoredRoutine } from '../types/MyDB';

function makeRoutine(overrides: Partial<StoredRoutine> & Pick<StoredRoutine, '_id' | 'title' | 'rrule'>): StoredRoutine {
    return {
        userId: 'user1',
        routineType: 'nextAction',
        template: {},
        active: true,
        createdTs: '2026-01-01T00:00:00.000Z',
        updatedTs: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

const weekdaysOf = (rrule: string, overrides: Partial<StoredRoutine> = {}) => fixedWeekdaysOf(makeRoutine({ _id: 'r', title: 'probe', rrule, ...overrides }));

describe('fixedWeekdaysOf', () => {
    it('spreads a plain daily rule across all seven days', () => {
        expect(weekdaysOf('FREQ=DAILY')).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });

    it('respects BYDAY on a DAILY rule (GCal "every weekday")', () => {
        expect(weekdaysOf('FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR')).toEqual([0, 1, 2, 3, 4]);
    });

    it('maps weekly BYDAY entries to Monday-first indexes', () => {
        expect(weekdaysOf('FREQ=WEEKLY;BYDAY=MO,TH')).toEqual([0, 3]);
        expect(weekdaysOf('FREQ=WEEKLY;BYDAY=SU')).toEqual([6]);
    });

    it('keeps Monday (weekday 0) despite being falsy', () => {
        expect(weekdaysOf('FREQ=WEEKLY;BYDAY=MO')).toEqual([0]);
    });

    it('keeps a capped series that still has upcoming occurrences', () => {
        const until = dayjs().add(1, 'year').format('YYYYMMDD');
        expect(weekdaysOf(`FREQ=WEEKLY;BYDAY=TH;UNTIL=${until}T000000Z`)).toEqual([3]);
    });

    it('drops a series whose UNTIL has already passed', () => {
        expect(weekdaysOf('FREQ=WEEKLY;BYDAY=TH;UNTIL=20200201T000000Z')).toBeNull();
    });

    it('drops a COUNT series exhausted relative to its real anchor', () => {
        expect(weekdaysOf('FREQ=DAILY;COUNT=3', { startDate: '2020-01-01' })).toBeNull();
    });

    it('returns null when the weekly rhythm is not fixed', () => {
        expect(weekdaysOf('FREQ=DAILY;INTERVAL=3')).toBeNull(); // every N days drifts across weekdays
        expect(weekdaysOf('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO')).toBeNull(); // fires only every other week
        expect(weekdaysOf('FREQ=WEEKLY')).toBeNull(); // day floats with the anchor date
        expect(weekdaysOf('FREQ=MONTHLY;BYMONTHDAY=1')).toBeNull();
        expect(weekdaysOf('NOT-AN-RRULE')).toBeNull();
    });
});

describe('buildRoutineWeekGrid', () => {
    it('places fixed-weekly routines on their days and collects the rest below', () => {
        const daily = makeRoutine({ _id: 'daily', title: 'Stretch', rrule: 'FREQ=DAILY' });
        const thursday = makeRoutine({ _id: 'thu', title: 'Pool', rrule: 'FREQ=WEEKLY;BYDAY=TH', routineType: 'calendar' });
        const monthly = makeRoutine({ _id: 'monthly', title: 'Pay rent', rrule: 'FREQ=MONTHLY;BYMONTHDAY=1' });
        const { days, lessFrequent } = buildRoutineWeekGrid([daily, thursday, monthly]);
        expect(days).toHaveLength(7);
        expect(days[0]?.map((r) => r._id)).toEqual(['daily']);
        // Both are timeless (no timeOfDay) — the tie breaks by title: Pool before Stretch.
        expect(days[3]?.map((r) => r._id)).toEqual(['thu', 'daily']);
        expect(lessFrequent.map((r) => r._id)).toEqual(['monthly']);
    });

    it('sorts a day column by time of day, timeless routines last, ties by title', () => {
        const evening = makeRoutine({
            _id: 'evening',
            title: 'Swim',
            rrule: 'FREQ=WEEKLY;BYDAY=MO',
            routineType: 'calendar',
            calendarItemTemplate: { timeOfDay: '18:00', duration: 60 },
        });
        const morning = makeRoutine({
            _id: 'morning',
            title: 'Standup',
            rrule: 'FREQ=WEEKLY;BYDAY=MO',
            routineType: 'calendar',
            calendarItemTemplate: { timeOfDay: '09:30', duration: 15 },
        });
        const timeless = makeRoutine({ _id: 'timeless', title: 'Journal', rrule: 'FREQ=WEEKLY;BYDAY=MO' });
        const { days } = buildRoutineWeekGrid([timeless, evening, morning]);
        expect(days[0]?.map((r) => r._id)).toEqual(['morning', 'evening', 'timeless']);
    });
});
