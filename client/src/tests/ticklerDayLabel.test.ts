import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { ticklerDayLabel } from '../lib/ticklerDayLabel';

// Pin "now" to mid-afternoon so the calendar-day vs 24h-span distinction actually bites:
// dayjs().diff(tomorrowMidnight, 'day') would round to 0 with elapsed-hours math.
const now = dayjs('2026-07-15T15:00:00');

describe('ticklerDayLabel', () => {
    it('labels the current calendar day as Today with its date', () => {
        expect(ticklerDayLabel('2026-07-15', now)).toBe('Today · Wed, Jul 15');
    });

    it('labels the next calendar day as Tomorrow — not Today — despite being under 24h away', () => {
        expect(ticklerDayLabel('2026-07-16', now)).toBe('Tomorrow · Thu, Jul 16');
    });

    it('shows weekday + date for a date later this week', () => {
        expect(ticklerDayLabel('2026-07-18', now)).toBe('Sat, Jul 18');
    });

    it('does not repeat the date — a far same-year date renders once', () => {
        expect(ticklerDayLabel('2026-08-04', now)).toBe('Tue, Aug 4');
    });

    it('includes the year only when the date is in a different year', () => {
        expect(ticklerDayLabel('2027-01-02', now)).toBe('Sat, Jan 2, 2027');
    });
});
