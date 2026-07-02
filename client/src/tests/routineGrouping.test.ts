import { describe, expect, it } from 'vitest';
import { approxIntervalDays, filterRoutinesByTitle, frequencyBucket, groupRoutines } from '../lib/routineGrouping';
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

describe('approxIntervalDays', () => {
    it('maps plain frequencies to their canonical day counts', () => {
        expect(approxIntervalDays('FREQ=DAILY')).toBe(1);
        expect(approxIntervalDays('FREQ=WEEKLY')).toBe(7);
        expect(approxIntervalDays('FREQ=MONTHLY')).toBe(30);
        expect(approxIntervalDays('FREQ=YEARLY')).toBe(365);
    });

    it('multiplies by INTERVAL', () => {
        expect(approxIntervalDays('FREQ=DAILY;INTERVAL=3')).toBe(3);
        expect(approxIntervalDays('FREQ=WEEKLY;INTERVAL=2')).toBe(14);
        expect(approxIntervalDays('FREQ=MONTHLY;INTERVAL=6')).toBe(180);
    });

    it('divides by the number of BYDAY entries so weekdays-only reads as near-daily', () => {
        expect(approxIntervalDays('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')).toBeCloseTo(1.4);
        expect(approxIntervalDays('FREQ=WEEKLY;BYDAY=MO,TH')).toBeCloseTo(3.5);
    });

    it('divides by the number of BYMONTHDAY entries', () => {
        expect(approxIntervalDays('FREQ=MONTHLY;BYMONTHDAY=1,15')).toBe(15);
    });

    it('sinks unparseable rules to the bottom', () => {
        expect(approxIntervalDays('NOT-AN-RRULE')).toBe(Number.MAX_SAFE_INTEGER);
        expect(approxIntervalDays('')).toBe(Number.MAX_SAFE_INTEGER);
    });
});

describe('frequencyBucket', () => {
    it('buckets canonical intervals into their own bucket', () => {
        expect(frequencyBucket(1)).toBe('Daily');
        expect(frequencyBucket(7)).toBe('Weekly');
        expect(frequencyBucket(30)).toBe('Monthly');
        expect(frequencyBucket(91)).toBe('Quarterly');
        expect(frequencyBucket(365)).toBe('Annual');
    });

    it('assigns in-between intervals by geometric proximity', () => {
        expect(frequencyBucket(1.4)).toBe('Daily'); // weekdays-only
        expect(frequencyBucket(3)).toBe('Weekly'); // every 3 days
        expect(frequencyBucket(14)).toBe('Weekly'); // every 2 weeks
        expect(frequencyBucket(21)).toBe('Monthly'); // every 3 weeks
        expect(frequencyBucket(180)).toBe('Quarterly'); // every 6 months
        expect(frequencyBucket(200)).toBe('Annual');
    });
});

describe('groupRoutines', () => {
    const dailyNa = makeRoutine({ _id: 'r1', title: 'Water plants', rrule: 'FREQ=DAILY' });
    const annualNa = makeRoutine({ _id: 'r2', title: 'Renew insurance', rrule: 'FREQ=YEARLY' });
    const monthlyNa = makeRoutine({ _id: 'r3', title: 'Pay rent', rrule: 'FREQ=MONTHLY;BYMONTHDAY=1' });
    const weeklyCal = makeRoutine({ _id: 'r4', title: 'Pool with Elena', rrule: 'FREQ=WEEKLY;BYDAY=TH', routineType: 'calendar' });
    const dailyCal = makeRoutine({ _id: 'r5', title: 'Morning swim', rrule: 'FREQ=DAILY', routineType: 'calendar' });

    it('puts the Next Action section before the Calendar section', () => {
        const sections = groupRoutines([weeklyCal, dailyNa]);
        expect(sections.map((s) => s.routineType)).toEqual(['nextAction', 'calendar']);
    });

    it('omits empty sections and empty buckets', () => {
        const sections = groupRoutines([dailyNa]);
        expect(sections).toHaveLength(1);
        const [section] = sections;
        if (!section) throw new Error('expected one section');
        expect(section.routineType).toBe('nextAction');
        expect(section.buckets.map((b) => b.bucket)).toEqual(['Daily']);
    });

    it('orders buckets daily → annual and sorts within a section by interval', () => {
        const sections = groupRoutines([annualNa, monthlyNa, dailyNa, weeklyCal, dailyCal]);
        const [nextActionSection, calendarSection] = sections;
        if (!nextActionSection || !calendarSection) throw new Error('expected two sections');
        expect(nextActionSection.buckets.map((b) => b.bucket)).toEqual(['Daily', 'Monthly', 'Annual']);
        expect(nextActionSection.buckets.flatMap((b) => b.routines.map((r) => r._id))).toEqual(['r1', 'r3', 'r2']);
        expect(calendarSection.buckets.map((b) => b.bucket)).toEqual(['Daily', 'Weekly']);
        expect(calendarSection.buckets.flatMap((b) => b.routines.map((r) => r._id))).toEqual(['r5', 'r4']);
    });

    it('renders a calendar-only list as a single calendar section (empty next-action section dropped)', () => {
        const sections = groupRoutines([weeklyCal, dailyCal]);
        expect(sections).toHaveLength(1);
        const [section] = sections;
        if (!section) throw new Error('expected one section');
        expect(section.routineType).toBe('calendar');
    });

    it('breaks interval ties by title', () => {
        const b = makeRoutine({ _id: 'rb', title: 'B daily', rrule: 'FREQ=DAILY' });
        const a = makeRoutine({ _id: 'ra', title: 'A daily', rrule: 'FREQ=DAILY' });
        const sections = groupRoutines([b, a]);
        const [section] = sections;
        if (!section) throw new Error('expected one section');
        expect(section.buckets.flatMap((g) => g.routines.map((r) => r._id))).toEqual(['ra', 'rb']);
    });
});

describe('filterRoutinesByTitle', () => {
    const routines = [
        makeRoutine({ _id: 'r1', title: 'Water plants', rrule: 'FREQ=DAILY' }),
        makeRoutine({ _id: 'r2', title: 'Pay rent', rrule: 'FREQ=MONTHLY' }),
    ];

    it('matches case-insensitively on a substring', () => {
        expect(filterRoutinesByTitle(routines, 'PLANT').map((r) => r._id)).toEqual(['r1']);
    });

    it('returns everything for a blank or undefined query', () => {
        expect(filterRoutinesByTitle(routines, undefined)).toHaveLength(2);
        expect(filterRoutinesByTitle(routines, '   ')).toHaveLength(2);
    });

    it('returns an empty list when nothing matches', () => {
        expect(filterRoutinesByTitle(routines, 'zzz')).toHaveLength(0);
    });
});
