import { describe, expect, it } from 'vitest';
import { deriveRecurrenceAnchor, extractUntilFromRrule } from '../lib/rruleHelpers.js';
import { extractLocalTime } from '../routes/calendar.js';

describe('extractUntilFromRrule', () => {
    it('returns null when no UNTIL clause is present', () => {
        expect(extractUntilFromRrule('FREQ=DAILY;INTERVAL=1')).toBeNull();
    });

    it('parses a UTC datetime UNTIL value', () => {
        expect(extractUntilFromRrule('FREQ=DAILY;INTERVAL=1;UNTIL=20260410T090000Z')).toBe('2026-04-10T09:00:00.000Z');
    });

    it('parses a bare date UNTIL as UTC midnight (not local time)', () => {
        // This is the critical case: bare date must be UTC to avoid server-timezone drift.
        const result = extractUntilFromRrule('FREQ=DAILY;INTERVAL=1;UNTIL=20260410');
        expect(result).toBe('2026-04-10T00:00:00.000Z');
    });

    it('handles UNTIL at the beginning of the rrule string', () => {
        expect(extractUntilFromRrule('UNTIL=20260101T000000Z;FREQ=DAILY')).toBe('2026-01-01T00:00:00.000Z');
    });

    it('handles UNTIL followed by other clauses', () => {
        expect(extractUntilFromRrule('FREQ=WEEKLY;UNTIL=20260315T235959Z;BYDAY=MO')).toBe('2026-03-15T23:59:59.000Z');
    });

    it('returns null for a malformed UNTIL value', () => {
        expect(extractUntilFromRrule('FREQ=DAILY;UNTIL=NOTADATE')).toBeNull();
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

describe('extractLocalTime', () => {
    it('converts UTC to Asia/Jerusalem (UTC+3 in summer)', () => {
        expect(extractLocalTime('2026-07-12T06:00:00Z', 'Asia/Jerusalem')).toBe('09:00');
    });

    it('converts UTC to America/New_York (UTC-4 in summer)', () => {
        expect(extractLocalTime('2026-07-12T06:00:00Z', 'America/New_York')).toBe('02:00');
    });

    it('returns UTC time when timezone is UTC', () => {
        expect(extractLocalTime('2026-04-12T06:00:00Z', 'UTC')).toBe('06:00');
    });

    it('handles midnight crossing (UTC time in previous day local)', () => {
        // 01:00 UTC = 21:00 previous day in New York (UTC-4)
        expect(extractLocalTime('2026-07-12T01:00:00Z', 'America/New_York')).toBe('21:00');
    });
});
