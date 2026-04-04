import { describe, expect, it } from 'vitest';
import { computeNextOccurrence, formatRrule } from '../lib/rruleUtils';

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
