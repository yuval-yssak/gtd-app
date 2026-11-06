import { describe, expect, it } from 'vitest';
import { withoutExceptionsFrom, withoutExceptionsPastSeriesEnd } from '../lib/routineExceptionPrune.js';
import type { RoutineInterface } from '../types/entities.js';

type RoutineException = NonNullable<RoutineInterface['routineExceptions']>[number];

function modifiedOn(date: string): RoutineException {
    return { date, type: 'modified', newTimeStart: `${date}T10:00:00` };
}

function skippedOn(date: string): RoutineException {
    return { date, type: 'skipped' };
}

function routineWith(rrule: string, routineExceptions: RoutineException[]): RoutineInterface {
    return {
        _id: 'r1',
        user: 'u1',
        title: 'Daily check',
        routineType: 'calendar',
        rrule,
        startDate: '2026-11-01',
        template: {},
        active: true,
        createdTs: '2026-10-27T00:00:00Z',
        updatedTs: '2026-10-27T00:00:00Z',
        routineExceptions,
    };
}

function exceptionDates(routine: RoutineInterface): string[] {
    return (routine.routineExceptions ?? []).map((e) => e.date);
}

describe('withoutExceptionsPastSeriesEnd', () => {
    it('drops exceptions dated after the UNTIL day and keeps the UNTIL day itself', () => {
        const routine = routineWith('FREQ=DAILY;UNTIL=20261106T235959Z', [modifiedOn('2026-11-05'), skippedOn('2026-11-06'), modifiedOn('2026-11-07')]);
        expect(exceptionDates(withoutExceptionsPastSeriesEnd(routine))).toEqual(['2026-11-05', '2026-11-06']);
    });

    it('drops exceptions after the last COUNT occurrence, counted from the series start', () => {
        const routine = routineWith('FREQ=DAILY;COUNT=10', [modifiedOn('2026-11-10'), modifiedOn('2026-11-11'), skippedOn('2027-04-20')]);
        expect(exceptionDates(withoutExceptionsPastSeriesEnd(routine))).toEqual(['2026-11-10']);
    });

    it('removes the field entirely when every exception is past the end', () => {
        const routine = routineWith('FREQ=DAILY;UNTIL=20261106T235959Z', [modifiedOn('2026-11-07'), skippedOn('2026-11-09')]);
        expect(withoutExceptionsPastSeriesEnd(routine)).not.toHaveProperty('routineExceptions');
    });

    it('returns the same routine when nothing is past the end', () => {
        const routine = routineWith('FREQ=DAILY;UNTIL=20261106T235959Z', [modifiedOn('2026-11-05')]);
        expect(withoutExceptionsPastSeriesEnd(routine)).toBe(routine);
    });

    it('leaves an open-ended series untouched', () => {
        const routine = routineWith('FREQ=DAILY', [modifiedOn('2030-01-01')]);
        expect(withoutExceptionsPastSeriesEnd(routine)).toBe(routine);
    });

    it('leaves a COUNT series without a startDate untouched — its createdTs anchor can be a day off', () => {
        const { startDate: _none, ...routine } = routineWith('FREQ=DAILY;COUNT=3', [modifiedOn('2026-11-20')]);
        expect(withoutExceptionsPastSeriesEnd(routine)).toBe(routine);
    });

    it('still honours UNTIL on a routine without a startDate', () => {
        const { startDate: _none, ...routine } = routineWith('FREQ=DAILY;UNTIL=20261106T235959Z', [modifiedOn('2026-11-06'), modifiedOn('2026-11-07')]);
        expect(exceptionDates(withoutExceptionsPastSeriesEnd(routine))).toEqual(['2026-11-06']);
    });

    it('leaves a routine without exceptions untouched', () => {
        const { routineExceptions: _none, ...routine } = routineWith('FREQ=DAILY;COUNT=3', []);
        expect(withoutExceptionsPastSeriesEnd(routine)).toBe(routine);
    });
});

describe('withoutExceptionsFrom', () => {
    it('drops exceptions on or after the given day and keeps earlier ones', () => {
        const routine = routineWith('FREQ=DAILY', [modifiedOn('2026-11-05'), skippedOn('2026-11-06'), modifiedOn('2026-11-07')]);
        expect(exceptionDates(withoutExceptionsFrom(routine, '2026-11-06'))).toEqual(['2026-11-05']);
    });

    it('returns the same routine when every exception is earlier', () => {
        const routine = routineWith('FREQ=DAILY', [modifiedOn('2026-11-05')]);
        expect(withoutExceptionsFrom(routine, '2026-11-06')).toBe(routine);
    });
});
