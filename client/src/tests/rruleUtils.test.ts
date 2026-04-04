import { describe, expect, it } from 'vitest';
import { computeNextOccurrence, formatCalendarRrule, formatRrule } from '../lib/rruleUtils';
import type { StoredRoutine } from '../types/MyDB';

describe('computeNextOccurrence', () => {
    it('returns the next daily occurrence strictly after afterDate', () => {
        const after = new Date('2024-01-10T12:00:00Z');
        const next = computeNextOccurrence('FREQ=DAILY;INTERVAL=1', after);
        expect(next.toISOString().slice(0, 10)).toBe('2024-01-11');
    });

    it('respects interval > 1', () => {
        // Use noon to avoid rrule boundary edge cases when DTSTART == afterDate at midnight
        const after = new Date('2024-01-10T12:00:00Z');
        const next = computeNextOccurrence('FREQ=DAILY;INTERVAL=7', after);
        expect(next.toISOString().slice(0, 10)).toBe('2024-01-17');
    });

    it('returns the next matching weekday for weekly rules', () => {
        // 2024-01-10 is a Wednesday; next Monday is 2024-01-15
        const after = new Date('2024-01-10T00:00:00Z');
        const next = computeNextOccurrence('FREQ=WEEKLY;BYDAY=MO', after);
        expect(next.toISOString().slice(0, 10)).toBe('2024-01-15');
    });

    it('returns the next occurrence of a monthly rule', () => {
        // After Jan 15, next 6th is Feb 6
        const after = new Date('2024-01-15T00:00:00Z');
        const next = computeNextOccurrence('FREQ=MONTHLY;BYMONTHDAY=6', after);
        expect(next.toISOString().slice(0, 10)).toBe('2024-02-06');
    });

    it('throws for rules with no future occurrence', () => {
        // UNTIL in the past guarantees rrule has no occurrence after afterDate
        expect(() => computeNextOccurrence('FREQ=DAILY;UNTIL=20230101T000000Z', new Date('2024-01-01T00:00:00Z'))).toThrow();
    });

    it('preserves the DTSTART time of day in the returned occurrence', () => {
        // Regression: RRule.fromString() without DTSTART inherits byhour/byminute/bysecond
        // from the clock at parse time, so occurrences would land at the wrong time of day.
        const after = new Date('2024-01-10T00:00:00Z');
        const next = computeNextOccurrence('FREQ=DAILY;INTERVAL=1', after);
        expect(next.toISOString()).toBe('2024-01-11T00:00:00.000Z');
    });
});

describe('formatRrule', () => {
    it('formats daily interval 1', () => {
        expect(formatRrule('FREQ=DAILY;INTERVAL=1')).toBe('Every day');
    });

    it('formats daily interval > 1', () => {
        expect(formatRrule('FREQ=DAILY;INTERVAL=3')).toBe('Every 3 days');
    });

    it('formats weekly specific days', () => {
        expect(formatRrule('FREQ=WEEKLY;BYDAY=MO,TH')).toBe('Every Mon & Thu');
    });

    it('formats weekly with interval', () => {
        expect(formatRrule('FREQ=WEEKLY;BYDAY=MO;INTERVAL=2')).toBe('Every Mon, every 2 weeks');
    });

    it('formats monthly by day of month', () => {
        expect(formatRrule('FREQ=MONTHLY;BYMONTHDAY=6')).toBe('Every 6th of the month');
    });

    it('formats yearly', () => {
        expect(formatRrule('FREQ=YEARLY')).toBe('Every year');
    });

    it('returns the raw string for unrecognised input', () => {
        expect(formatRrule('GARBAGE')).toBe('GARBAGE');
    });
});

describe('formatCalendarRrule', () => {
    const baseRoutine: StoredRoutine = {
        _id: 'r1',
        userId: 'u1',
        title: 'Family time',
        routineType: 'calendar',
        rrule: 'FREQ=WEEKLY;BYDAY=TH',
        template: {},
        active: true,
        createdTs: '2024-01-01T00:00:00Z',
        updatedTs: '2024-01-01T00:00:00Z',
    };

    it('formats frequency + time + duration for full hours', () => {
        const routine: StoredRoutine = { ...baseRoutine, calendarItemTemplate: { timeOfDay: '18:00', duration: 180 } };
        expect(formatCalendarRrule(routine)).toBe('Every Thu at 18:00 for 3h');
    });

    it('formats mixed hours and minutes', () => {
        const routine: StoredRoutine = { ...baseRoutine, calendarItemTemplate: { timeOfDay: '09:30', duration: 90 } };
        expect(formatCalendarRrule(routine)).toBe('Every Thu at 09:30 for 1h 30m');
    });

    it('formats minutes-only duration', () => {
        const routine: StoredRoutine = { ...baseRoutine, calendarItemTemplate: { timeOfDay: '14:00', duration: 45 } };
        expect(formatCalendarRrule(routine)).toBe('Every Thu at 14:00 for 45m');
    });

    it('falls back to formatRrule when calendarItemTemplate is absent', () => {
        expect(formatCalendarRrule(baseRoutine)).toBe('Every Thu');
    });
});
