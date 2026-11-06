import { describe, expect, it } from 'vitest';
import { isPastSeriesEnd } from '../lib/splitChainResolution.js';
import type { RoutineInterface } from '../types/entities.js';

function routineWith(rrule: string, startDate = '2026-11-01'): RoutineInterface {
    return {
        _id: 'r1',
        user: 'u1',
        title: 'Daily check',
        routineType: 'calendar',
        rrule,
        startDate,
        template: {},
        active: true,
        createdTs: '2026-10-27T00:00:00Z',
        updatedTs: '2026-10-27T00:00:00Z',
    };
}

describe('isPastSeriesEnd', () => {
    it('counts COUNT from the series start, not from today', () => {
        const routine = routineWith('FREQ=DAILY;COUNT=10');
        expect(isPastSeriesEnd(routine, '2026-11-10')).toBe(false);
        expect(isPastSeriesEnd(routine, '2026-11-11')).toBe(true);
    });

    it('honours COUNT on a sparse rule', () => {
        const routine = routineWith('FREQ=WEEKLY;BYDAY=MO;COUNT=2', '2026-11-02');
        expect(isPastSeriesEnd(routine, '2026-11-09')).toBe(false);
        expect(isPastSeriesEnd(routine, '2026-11-10')).toBe(true);
    });

    it('treats the UNTIL day itself as inside the series', () => {
        const routine = routineWith('FREQ=DAILY;UNTIL=20261110T235959Z');
        expect(isPastSeriesEnd(routine, '2026-11-10')).toBe(false);
        expect(isPastSeriesEnd(routine, '2026-11-11')).toBe(true);
    });

    it('treats a date-only UNTIL as covering its whole last day', () => {
        const routine = routineWith('FREQ=DAILY;UNTIL=20261110');
        expect(isPastSeriesEnd(routine, '2026-11-10')).toBe(false);
        expect(isPastSeriesEnd(routine, '2026-11-11')).toBe(true);
    });

    it('treats an over-large COUNT as open-ended instead of expanding it', () => {
        expect(isPastSeriesEnd(routineWith('FREQ=DAILY;COUNT=200000000'), '2030-01-01')).toBe(false);
    });

    it('treats a malformed rule as open-ended instead of throwing', () => {
        expect(isPastSeriesEnd(routineWith('FREQ=DAILY;COUNT=3;BYDAY=NOTADAY'), '2030-01-01')).toBe(false);
    });

    it('never ends an open-ended series', () => {
        expect(isPastSeriesEnd(routineWith('FREQ=DAILY'), '2030-01-01')).toBe(false);
    });

    it('falls back to createdTs when the routine has no startDate', () => {
        const { startDate: _omit, ...routine } = routineWith('FREQ=DAILY;COUNT=3');
        expect(isPastSeriesEnd(routine, '2026-10-29')).toBe(false);
        expect(isPastSeriesEnd(routine, '2026-10-30')).toBe(true);
    });
});
