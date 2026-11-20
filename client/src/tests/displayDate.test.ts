import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { formatDisplayDate } from '../lib/displayDate';
import { pinClockAt } from './pinClock';

const now = dayjs('2026-07-15T15:00:00');

describe('formatDisplayDate', () => {
    it('omits the year for a date in the current year', () => {
        expect(formatDisplayDate(dayjs('2026-10-27'), 'MMM D', now)).toBe('Oct 27');
    });

    it('appends the year for a date in a later year', () => {
        expect(formatDisplayDate(dayjs('2027-01-02'), 'MMM D', now)).toBe('Jan 2, 2027');
    });

    it('appends the year for a date in an earlier year', () => {
        expect(formatDisplayDate(dayjs('2025-12-30'), 'ddd, MMM D', now)).toBe('Tue, Dec 30, 2025');
    });

    it.each([
        ['ddd MMM D', 'Sat Jan 2, 2027'],
        ['dddd, MMM D', 'Saturday, Jan 2, 2027'],
    ] as const)('keeps the %s weekday style when adding the year', (pattern, expected) => {
        expect(formatDisplayDate(dayjs('2027-01-02'), pattern, now)).toBe(expected);
    });

    it('treats Dec 31 and Jan 1 of the current year as the current year', () => {
        expect(formatDisplayDate(dayjs('2026-01-01'), 'MMM D', now)).toBe('Jan 1');
        expect(formatDisplayDate(dayjs('2026-12-31'), 'MMM D', now)).toBe('Dec 31');
    });

    describe('without an explicit now', () => {
        pinClockAt('2027-03-01T12:00:00');

        it('compares against the device clock', () => {
            expect(formatDisplayDate(dayjs('2027-01-02'), 'MMM D')).toBe('Jan 2');
            expect(formatDisplayDate(dayjs('2026-10-27'), 'MMM D')).toBe('Oct 27, 2026');
        });
    });
});
