import { describe, expect, it } from 'vitest';
import { formatAllDayDate, fromGCalExclusive, isAllDayDateString, toGCalExclusive } from '../lib/allDayDate';

describe('toGCalExclusive', () => {
    // Plan canonical case: Wed (inclusive end) → Thu (GCal exclusive end) for a single-day event.
    it('shifts a single-day inclusive end by +1 day', () => {
        expect(toGCalExclusive('2026-05-27')).toBe('2026-05-28');
    });

    it('shifts across month boundaries', () => {
        expect(toGCalExclusive('2026-05-31')).toBe('2026-06-01');
    });

    it('shifts across year boundaries', () => {
        expect(toGCalExclusive('2026-12-31')).toBe('2027-01-01');
    });

    it('handles leap-day end (2024-02-28 → 2024-02-29)', () => {
        expect(toGCalExclusive('2024-02-28')).toBe('2024-02-29');
    });
});

describe('fromGCalExclusive', () => {
    it('shifts a GCal exclusive end back by 1 day', () => {
        expect(fromGCalExclusive('2026-05-28')).toBe('2026-05-27');
    });

    it('shifts across month boundaries', () => {
        expect(fromGCalExclusive('2026-06-01')).toBe('2026-05-31');
    });

    it('shifts across year boundaries', () => {
        expect(fromGCalExclusive('2027-01-01')).toBe('2026-12-31');
    });
});

describe('toGCalExclusive / fromGCalExclusive round-trip', () => {
    // Round-trip on a sampling that crosses month/year/leap-day boundaries — any rounding/tz drift
    // here would silently corrupt all-day event timing on save, so the test pins the inverse property.
    it.each([
        '2026-01-01',
        '2026-02-28',
        '2024-02-29',
        '2026-05-27',
        '2026-12-31',
        '2027-01-01',
    ])('round-trips %s through toGCalExclusive → fromGCalExclusive', (date) => {
        expect(fromGCalExclusive(toGCalExclusive(date))).toBe(date);
    });

    it.each(['2026-01-02', '2026-03-01', '2024-03-01', '2026-05-28', '2027-01-01'])('round-trips %s through fromGCalExclusive → toGCalExclusive', (date) => {
        expect(toGCalExclusive(fromGCalExclusive(date))).toBe(date);
    });
});

describe('formatAllDayDate', () => {
    it('formats with the default MMM D format', () => {
        expect(formatAllDayDate('2026-05-27')).toBe('May 27');
    });

    it('respects a custom format', () => {
        expect(formatAllDayDate('2026-05-27', 'YYYY-MM-DD')).toBe('2026-05-27');
        expect(formatAllDayDate('2026-05-27', 'ddd, MMM D')).toBe('Wed, May 27');
    });

    // Regression: dayjs(date).tz(...) would shift "May 23" to "May 22" in negative-offset zones.
    // The naive parser preserves the calendar date verbatim, which is what all-day semantics demand.
    it('does not tz-shift — the formatted day equals the input day', () => {
        const inputDay = '2026-05-23';
        expect(formatAllDayDate(inputDay, 'YYYY-MM-DD')).toBe(inputDay);
    });
});

describe('isAllDayDateString', () => {
    it('returns true for YYYY-MM-DD', () => {
        expect(isAllDayDateString('2026-05-27')).toBe(true);
        expect(isAllDayDateString('2024-02-29')).toBe(true);
    });

    it('returns false for ISO datetime strings', () => {
        expect(isAllDayDateString('2026-05-27T00:00:00.000Z')).toBe(false);
        expect(isAllDayDateString('2026-05-27T09:30:00.000Z')).toBe(false);
    });

    it('returns false for undefined and empty', () => {
        expect(isAllDayDateString(undefined)).toBe(false);
        expect(isAllDayDateString('')).toBe(false);
    });

    it('returns false for malformed inputs', () => {
        expect(isAllDayDateString('2026-5-27')).toBe(false);
        expect(isAllDayDateString('not a date')).toBe(false);
        expect(isAllDayDateString('20260527')).toBe(false);
    });
});
