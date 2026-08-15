import { describe, expect, it } from 'vitest';
import { approxIntervalDays, filterRoutinesByTitle, frequencyBucket, groupRoutinesByFrequency, splitActivePaused } from '../lib/routineGrouping';
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

describe('groupRoutinesByFrequency', () => {
    const dailyNa = makeRoutine({ _id: 'r1', title: 'Water plants', rrule: 'FREQ=DAILY' });
    const annualNa = makeRoutine({ _id: 'r2', title: 'Renew insurance', rrule: 'FREQ=YEARLY' });
    const monthlyNa = makeRoutine({ _id: 'r3', title: 'Pay rent', rrule: 'FREQ=MONTHLY;BYMONTHDAY=1' });

    it('omits empty buckets', () => {
        const buckets = groupRoutinesByFrequency([dailyNa]);
        expect(buckets.map((b) => b.bucket)).toEqual(['Daily']);
    });

    it('orders buckets daily → annual and sorts within by interval', () => {
        const buckets = groupRoutinesByFrequency([annualNa, monthlyNa, dailyNa]);
        expect(buckets.map((b) => b.bucket)).toEqual(['Daily', 'Monthly', 'Annual']);
        expect(buckets.flatMap((b) => b.routines.map((r) => r._id))).toEqual(['r1', 'r3', 'r2']);
    });

    it('breaks interval ties by title', () => {
        const b = makeRoutine({ _id: 'rb', title: 'B daily', rrule: 'FREQ=DAILY' });
        const a = makeRoutine({ _id: 'ra', title: 'A daily', rrule: 'FREQ=DAILY' });
        const buckets = groupRoutinesByFrequency([b, a]);
        expect(buckets.flatMap((g) => g.routines.map((r) => r._id))).toEqual(['ra', 'rb']);
    });
});

describe('splitActivePaused', () => {
    it('separates paused routines and keeps them interval-then-title sorted', () => {
        const activeDaily = makeRoutine({ _id: 'a1', title: 'Water plants', rrule: 'FREQ=DAILY' });
        const pausedAnnual = makeRoutine({ _id: 'p1', title: 'Old habit', rrule: 'FREQ=YEARLY', active: false });
        const pausedDaily = makeRoutine({ _id: 'p2', title: 'Dormant daily', rrule: 'FREQ=DAILY', active: false });
        const { active, paused } = splitActivePaused([pausedAnnual, activeDaily, pausedDaily]);
        expect(active.map((r) => r._id)).toEqual(['a1']);
        expect(paused.map((r) => r._id)).toEqual(['p2', 'p1']);
    });

    it('preserves input order for active routines (bucketing re-sorts downstream)', () => {
        const annual = makeRoutine({ _id: 'a1', title: 'Renew insurance', rrule: 'FREQ=YEARLY' });
        const daily = makeRoutine({ _id: 'a2', title: 'Water plants', rrule: 'FREQ=DAILY' });
        expect(splitActivePaused([annual, daily]).active.map((r) => r._id)).toEqual(['a1', 'a2']);
    });

    it('returns empty halves for an empty input', () => {
        expect(splitActivePaused([])).toEqual({ active: [], paused: [] });
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
