import { describe, expect, it } from 'vitest';
import { dayCellLabel, isInMonth, monthGridWeeks, quickDatePicks, shiftMonth, startOfMonthIso, weekdayLabels } from '../lib/datePickerGrid';

// Fixed anchors: 2026-10-03 is a Saturday, 2026-10-05 the following Monday.
const SATURDAY = '2026-10-03';

describe('datePickerGrid', () => {
    describe('startOfMonthIso', () => {
        it('seeds from the field value when one is set', () => {
            expect(startOfMonthIso('2027-02-14', SATURDAY)).toBe('2027-02-01');
        });

        it('falls back to today for an empty field', () => {
            expect(startOfMonthIso('', SATURDAY)).toBe('2026-10-01');
        });
    });

    describe('shiftMonth', () => {
        it('crosses the year boundary in both directions', () => {
            expect(shiftMonth('2026-12-01', 1)).toBe('2027-01-01');
            expect(shiftMonth('2026-01-01', -1)).toBe('2025-12-01');
        });
    });

    describe('monthGridWeeks', () => {
        it('always yields six seven-day weeks so the popover height is stable', () => {
            // February 2026 fits in four rows; the grid must still pad to six.
            const weeks = monthGridWeeks('2026-02-01');
            expect(weeks).toHaveLength(6);
            for (const week of weeks) expect(week).toHaveLength(7);
        });

        it('starts on the locale week start and covers every day of the month in order', () => {
            // 1 Oct 2026 is a Thursday, so the Sunday-start grid opens on 27 Sep.
            const days = monthGridWeeks('2026-10-01').flat();
            expect(days[0]).toBe('2026-09-27');
            expect(days.indexOf('2026-10-01')).toBe(4);
            expect(days.indexOf('2026-10-31')).toBe(34);
            expect(days.filter((d) => isInMonth(d, '2026-10-01'))).toHaveLength(31);
        });
    });

    describe('weekdayLabels', () => {
        it('returns seven two-letter headers starting with the locale week start', () => {
            const labels = weekdayLabels();
            expect(labels).toHaveLength(7);
            expect(labels[0]).toBe('Su');
            expect(labels[6]).toBe('Sa');
        });
    });

    describe('quickDatePicks', () => {
        it('offers today, tomorrow, next Monday, a week and a month ahead', () => {
            expect(quickDatePicks(SATURDAY)).toEqual([
                { label: 'Today', date: '2026-10-03' },
                { label: 'Tomorrow', date: '2026-10-04' },
                { label: 'Next Mon', date: '2026-10-05' },
                { label: 'In a week', date: '2026-10-10' },
                { label: 'In a month', date: '2026-11-03' },
            ]);
        });

        it('skips a whole week for "Next Mon" when today is already a Monday', () => {
            // "Next Monday" on a Monday means the one after — not today.
            const picks = quickDatePicks('2026-10-05');
            expect(picks.find((p) => p.label === 'Next Mon')?.date).toBe('2026-10-12');
        });

        it('clamps "In a month" to the last day of a shorter month', () => {
            expect(quickDatePicks('2026-01-31').find((p) => p.label === 'In a month')?.date).toBe('2026-02-28');
        });
    });

    describe('boundary days', () => {
        it('picks tomorrow as "Next Mon" when today is a Sunday', () => {
            expect(quickDatePicks('2026-10-04').find((p) => p.label === 'Next Mon')?.date).toBe('2026-10-05');
        });

        it('opens the grid on the 1st when the month starts on the week-start day', () => {
            // Feb 2026 starts on a Sunday — the first row must be the month itself, not a padding week.
            const [firstDay] = monthGridWeeks('2026-02-01').flat();
            expect(firstDay).toBe('2026-02-01');
        });
    });

    describe('dayCellLabel', () => {
        it('spells out the weekday, month, day and year for screen readers and e2e locators', () => {
            expect(dayCellLabel('2026-10-15')).toBe('Thursday, October 15, 2026');
        });
    });
});
