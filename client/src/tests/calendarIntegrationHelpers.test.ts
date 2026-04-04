import { describe, expect, it } from 'vitest';
import { resolveSelectedCalendarId } from '../components/settings/CalendarIntegrations';

const calendars = [
    { id: 'cal-1', name: 'Work' },
    { id: 'cal-2', name: 'Personal' },
];

describe('resolveSelectedCalendarId', () => {
    it('returns the user-selected ID when set', () => {
        expect(resolveSelectedCalendarId('cal-2', calendars, 'primary')).toBe('cal-2');
    });

    it("defaults to first calendar when integration's calendarId is not in the list", () => {
        // 'primary' is a GCal alias that doesn't appear by name in calendarList
        expect(resolveSelectedCalendarId(null, calendars, 'primary')).toBe('cal-1');
    });

    it("keeps integration's calendarId when it is in the list", () => {
        expect(resolveSelectedCalendarId(null, calendars, 'cal-2')).toBe('cal-2');
    });

    it('falls back to integrationCalendarId when calendar list is empty', () => {
        expect(resolveSelectedCalendarId(null, [], 'primary')).toBe('primary');
    });
});
