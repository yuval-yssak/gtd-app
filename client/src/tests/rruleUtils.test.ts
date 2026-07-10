import { describe, expect, it } from 'vitest';
import { computeNextOccurrence, deriveRecurrenceAnchor, formatCalendarRrule, formatRrule } from '../lib/rruleUtils';
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

    // ── includeAnchor=true: used for the first item of a brand-new routine so a daily/interval
    //    rule lands today rather than tomorrow.
    describe('includeAnchor=true', () => {
        it('daily rule: returns the anchor date itself when DTSTART matches', () => {
            const anchor = new Date('2024-01-10T00:00:00Z');
            const next = computeNextOccurrence('FREQ=DAILY;INTERVAL=1', anchor, true);
            expect(next.toISOString().slice(0, 10)).toBe('2024-01-10');
        });

        it('every-3-days rule: returns the anchor date itself when DTSTART matches', () => {
            const anchor = new Date('2024-01-10T00:00:00Z');
            const next = computeNextOccurrence('FREQ=DAILY;INTERVAL=3', anchor, true);
            expect(next.toISOString().slice(0, 10)).toBe('2024-01-10');
        });

        it('weekly rule (BYDAY=MO) anchored on a Wednesday: returns next Monday', () => {
            // 2024-01-10 is a Wednesday; next Monday is 2024-01-15
            const anchor = new Date('2024-01-10T00:00:00Z');
            const next = computeNextOccurrence('FREQ=WEEKLY;BYDAY=MO', anchor, true);
            expect(next.toISOString().slice(0, 10)).toBe('2024-01-15');
        });

        it('weekly rule (BYDAY=WE) anchored on a Wednesday: returns the anchor date', () => {
            const anchor = new Date('2024-01-10T00:00:00Z');
            const next = computeNextOccurrence('FREQ=WEEKLY;BYDAY=WE', anchor, true);
            expect(next.toISOString().slice(0, 10)).toBe('2024-01-10');
        });

        it('monthly rule (BYMONTHDAY=15) anchored on the 15th: returns the anchor date', () => {
            const anchor = new Date('2024-01-15T00:00:00Z');
            const next = computeNextOccurrence('FREQ=MONTHLY;BYMONTHDAY=15', anchor, true);
            expect(next.toISOString().slice(0, 10)).toBe('2024-01-15');
        });

        it('monthly rule (BYMONTHDAY=15) anchored on the 10th: returns the next 15th', () => {
            const anchor = new Date('2024-01-10T00:00:00Z');
            const next = computeNextOccurrence('FREQ=MONTHLY;BYMONTHDAY=15', anchor, true);
            expect(next.toISOString().slice(0, 10)).toBe('2024-01-15');
        });
    });

    // ── Floating vs fixed recurrence — locks in the already-correct rrule-library behavior that
    //    `recurrenceAnchor` relies on. No computation change was needed for this feature; these
    //    tests exist so a future refactor of computeNextOccurrence can't silently regress it.
    describe('floating vs fixed monthly recurrence', () => {
        it('floating (bare FREQ=MONTHLY): on-time completion advances one month from the same day', () => {
            // Due day 15, completed exactly on day 15.
            const completed = new Date('2024-01-15T00:00:00Z');
            const next = computeNextOccurrence('FREQ=MONTHLY', completed);
            expect(next.toISOString().slice(0, 10)).toBe('2024-02-15');
        });

        it('floating: early completion re-anchors to the earlier day, not the original due day', () => {
            // Due day 15, completed early on day 10 — next occurrence floats to day 10, not 15.
            const completed = new Date('2024-01-10T00:00:00Z');
            const next = computeNextOccurrence('FREQ=MONTHLY', completed);
            expect(next.toISOString().slice(0, 10)).toBe('2024-02-10');
        });

        it('floating: late completion re-anchors to the later day, not the original due day', () => {
            // Due day 15, completed late on day 28 — next occurrence floats to day 28.
            const completed = new Date('2024-01-28T00:00:00Z');
            const next = computeNextOccurrence('FREQ=MONTHLY', completed);
            expect(next.toISOString().slice(0, 10)).toBe('2024-02-28');
        });

        it('floating: multi-month-late completion advances one period from the ACTUAL completion date, not the original due date', () => {
            // The routine was due months ago; whenever it's finally completed, the next occurrence
            // is one period after the real completion date — this is the crux of "floating" and the
            // most likely place a future refactor could regress it.
            const completedMuchLater = new Date('2024-06-03T00:00:00Z');
            const next = computeNextOccurrence('FREQ=MONTHLY', completedMuchLater);
            expect(next.toISOString().slice(0, 10)).toBe('2024-07-03');
        });

        it('fixed BYMONTHDAY=31: skips a short month and lands on the next 31-day month', () => {
            const anchor = new Date('2024-04-01T00:00:00Z');
            const next = computeNextOccurrence('FREQ=MONTHLY;BYMONTHDAY=31', anchor);
            expect(next.toISOString().slice(0, 10)).toBe('2024-05-31');
        });

        it('floating: completion on the 31st skips a month with no 31st entirely (documented, not a bug)', () => {
            // Jan 31 -> next is Mar 31, NOT Feb (Feb has no 31st, so rrule skips the period).
            const completed = new Date('2024-01-31T00:00:00Z');
            const next = computeNextOccurrence('FREQ=MONTHLY', completed);
            expect(next.toISOString().slice(0, 10)).toBe('2024-03-31');
        });
    });

    describe('floating vs fixed weekly recurrence', () => {
        it('floating (bare FREQ=WEEKLY): re-anchors to the completion weekday', () => {
            // 2024-01-10 is a Wednesday.
            const completed = new Date('2024-01-10T00:00:00Z');
            const next = computeNextOccurrence('FREQ=WEEKLY', completed);
            expect(next.toISOString().slice(0, 10)).toBe('2024-01-17');
        });

        it('fixed BYDAY=MO: late completion still lands on the next Monday, not the completion weekday', () => {
            // Due Monday, completed late on Wednesday — next occurrence is still Monday.
            const completed = new Date('2024-01-10T00:00:00Z'); // Wednesday
            const next = computeNextOccurrence('FREQ=WEEKLY;BYDAY=MO', completed);
            expect(next.toISOString().slice(0, 10)).toBe('2024-01-15'); // next Monday
        });
    });
});

describe('deriveRecurrenceAnchor', () => {
    it('bare FREQ=MONTHLY is floating', () => {
        expect(deriveRecurrenceAnchor('FREQ=MONTHLY')).toBe('floating');
    });

    it('FREQ=MONTHLY;BYMONTHDAY=N is fixed', () => {
        expect(deriveRecurrenceAnchor('FREQ=MONTHLY;BYMONTHDAY=15')).toBe('fixed');
    });

    it('bare FREQ=WEEKLY is floating', () => {
        expect(deriveRecurrenceAnchor('FREQ=WEEKLY')).toBe('floating');
    });

    it('FREQ=WEEKLY;BYDAY=MO is fixed', () => {
        expect(deriveRecurrenceAnchor('FREQ=WEEKLY;BYDAY=MO')).toBe('fixed');
    });

    it('FREQ=YEARLY is floating (no day-of-year picker exists yet)', () => {
        expect(deriveRecurrenceAnchor('FREQ=YEARLY')).toBe('floating');
    });

    it('FREQ=DAILY is floating (moot, but must not throw)', () => {
        expect(deriveRecurrenceAnchor('FREQ=DAILY;INTERVAL=3')).toBe('floating');
    });

    it('is robust to UNTIL/COUNT clause ordering around BYMONTHDAY', () => {
        expect(deriveRecurrenceAnchor('FREQ=MONTHLY;COUNT=5;BYMONTHDAY=8')).toBe('fixed');
        expect(deriveRecurrenceAnchor('UNTIL=20260101T000000Z;FREQ=MONTHLY')).toBe('floating');
    });

    it('is case-insensitive', () => {
        expect(deriveRecurrenceAnchor('freq=monthly;bymonthday=8')).toBe('fixed');
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

    it('shows "until" date when rrule has UNTIL', () => {
        const routine: StoredRoutine = {
            ...baseRoutine,
            rrule: 'FREQ=DAILY;INTERVAL=3;UNTIL=20260414T235959Z',
            calendarItemTemplate: { timeOfDay: '09:00', duration: 60 },
        };
        expect(formatCalendarRrule(routine)).toBe('Every 3 days at 09:00 for 1h, until Apr 14');
    });

    it('shows "from" date when routine is a split tail', () => {
        const routine: StoredRoutine = {
            ...baseRoutine,
            splitFromRoutineId: 'parent-id',
            createdTs: '2026-04-15T00:00:00Z',
            calendarItemTemplate: { timeOfDay: '09:00', duration: 60 },
        };
        expect(formatCalendarRrule(routine)).toBe('Every Thu at 09:00 for 1h, from Apr 15');
    });

    it('shows both "from" and "until" for a bounded split tail', () => {
        const routine: StoredRoutine = {
            ...baseRoutine,
            splitFromRoutineId: 'parent-id',
            createdTs: '2026-04-15T00:00:00Z',
            rrule: 'FREQ=DAILY;INTERVAL=1;UNTIL=20260501T235959Z',
            calendarItemTemplate: { timeOfDay: '10:00', duration: 30 },
        };
        expect(formatCalendarRrule(routine)).toBe('Every day at 10:00 for 30m, from Apr 15, until May 1');
    });

    it('shows occurrence count for COUNT rules', () => {
        const routine: StoredRoutine = {
            ...baseRoutine,
            rrule: 'FREQ=DAILY;COUNT=5;INTERVAL=3',
            calendarItemTemplate: { timeOfDay: '09:00', duration: 60 },
        };
        expect(formatCalendarRrule(routine)).toBe('Every 3 days at 09:00 for 1h, 5 occurrences');
    });

    it('uses singular form for COUNT=1', () => {
        const routine: StoredRoutine = {
            ...baseRoutine,
            rrule: 'FREQ=DAILY;COUNT=1',
            calendarItemTemplate: { timeOfDay: '09:00', duration: 60 },
        };
        expect(formatCalendarRrule(routine)).toBe('Every day at 09:00 for 1h, 1 occurrence');
    });
});
