import { describe, expect, it } from 'vitest';
import { buildDateTime, endDateTime, seriesStartDate } from '../calendarProviders/GoogleCalendarProvider.js';
import type { RoutineInterface } from '../types/entities.js';

function makeRoutine(rrule: string, createdTs: string): RoutineInterface {
    return {
        _id: 'r1',
        user: 'u1',
        title: 't',
        routineType: 'calendar',
        rrule,
        template: {},
        active: true,
        createdTs,
        updatedTs: createdTs,
        calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
    };
}

describe('buildDateTime', () => {
    it('builds a valid dateTime for HH:MM input', () => {
        expect(buildDateTime('2026-04-11', '09:00', 'UTC')).toEqual({ dateTime: '2026-04-11T09:00:00', timeZone: 'UTC' });
    });

    it('handles 23:59 (end of day)', () => {
        expect(buildDateTime('2026-04-11', '23:59', 'UTC')).toEqual({ dateTime: '2026-04-11T23:59:00', timeZone: 'UTC' });
    });

    it('throws for empty string', () => {
        expect(() => buildDateTime('2026-04-11', '', 'UTC')).toThrow('Invalid timeOfDay');
    });

    it('throws for single-digit hour', () => {
        expect(() => buildDateTime('2026-04-11', '9:00', 'UTC')).toThrow('Invalid timeOfDay');
    });

    it('throws for format with seconds', () => {
        expect(() => buildDateTime('2026-04-11', '09:00:00', 'UTC')).toThrow('Invalid timeOfDay');
    });

    it('throws for out-of-range hour', () => {
        expect(() => buildDateTime('2026-04-11', '25:00', 'UTC')).toThrow('Invalid timeOfDay');
    });

    it('throws for out-of-range minutes', () => {
        expect(() => buildDateTime('2026-04-11', '12:60', 'UTC')).toThrow('Invalid timeOfDay');
    });

    it('accepts 00:00 (midnight)', () => {
        expect(buildDateTime('2026-04-11', '00:00', 'UTC')).toEqual({ dateTime: '2026-04-11T00:00:00', timeZone: 'UTC' });
    });
});

describe('endDateTime', () => {
    it('adds duration to start time', () => {
        expect(endDateTime('2026-04-11', '09:00', 60, 'UTC')).toEqual({ dateTime: '2026-04-11T10:00:00', timeZone: 'UTC' });
    });

    it('handles midnight overflow', () => {
        expect(endDateTime('2026-04-11', '23:00', 120, 'UTC')).toEqual({ dateTime: '2026-04-12T01:00:00', timeZone: 'UTC' });
    });

    it('throws for empty timeOfDay', () => {
        expect(() => endDateTime('2026-04-11', '', 60, 'UTC')).toThrow('Invalid timeOfDay');
    });

    it('throws for invalid timeOfDay format', () => {
        expect(() => endDateTime('2026-04-11', '9:00', 30, 'UTC')).toThrow('Invalid timeOfDay');
    });
});

describe('seriesStartDate', () => {
    it('snaps forward to the next BYDAY match when createdTs is not a match', () => {
        // 2026-04-22 is a Wednesday; the rule is weekly Monday — the next Monday is 2026-04-27.
        const routine = makeRoutine('FREQ=WEEKLY;BYDAY=MO', '2026-04-22T16:57:27.117Z');
        expect(seriesStartDate(routine)).toBe('2026-04-27');
    });

    it('preserves createdTs when it already matches BYDAY', () => {
        // 2026-04-27 is a Monday — already a match, stays put.
        const routine = makeRoutine('FREQ=WEEKLY;BYDAY=MO', '2026-04-27T08:00:00.000Z');
        expect(seriesStartDate(routine)).toBe('2026-04-27');
    });

    it('preserves createdTs for FREQ=DAILY (every day matches)', () => {
        const routine = makeRoutine('FREQ=DAILY', '2026-04-22T16:57:27.117Z');
        expect(seriesStartDate(routine)).toBe('2026-04-22');
    });

    it('snaps forward for multi-day BYDAY to the nearest matching day', () => {
        // 2026-04-22 is Wednesday; rule is Mon+Fri — nearest match is Fri 2026-04-24.
        const routine = makeRoutine('FREQ=WEEKLY;BYDAY=MO,FR', '2026-04-22T16:57:27.117Z');
        expect(seriesStartDate(routine)).toBe('2026-04-24');
    });

    it('snaps forward for monthly BYMONTHDAY when createdTs is before the target day', () => {
        // createdTs is Apr 22; rule is monthly on the 27th — next match is Apr 27.
        const routine = makeRoutine('FREQ=MONTHLY;BYMONTHDAY=27', '2026-04-22T16:57:27.117Z');
        expect(seriesStartDate(routine)).toBe('2026-04-27');
    });

    it('rolls to next month for monthly BYMONTHDAY when createdTs is past the target day', () => {
        // createdTs is Apr 22; rule is monthly on the 5th — next match is May 5.
        const routine = makeRoutine('FREQ=MONTHLY;BYMONTHDAY=5', '2026-04-22T16:57:27.117Z');
        expect(seriesStartDate(routine)).toBe('2026-05-05');
    });

    it('throws when the rrule has no occurrences on or after createdTs', () => {
        // UNTIL predates createdTs — the rule yields zero occurrences.
        const routine = makeRoutine('FREQ=WEEKLY;BYDAY=MO;UNTIL=20260101T000000Z', '2026-04-22T16:57:27.117Z');
        expect(() => seriesStartDate(routine)).toThrow(/no occurrences/);
    });
});
