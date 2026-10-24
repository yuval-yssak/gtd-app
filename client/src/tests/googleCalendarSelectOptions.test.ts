import { describe, expect, it } from 'vitest';
import type { GoogleCalendar } from '../api/calendarApi';
import { googleCalendarSelectOptions } from '../components/settings/CalendarIntegrations';

function cal(id: string, name: string, opts?: { primary?: boolean; accessRole?: string }): GoogleCalendar {
    return { id, name, primary: opts?.primary ?? false, accessRole: opts?.accessRole ?? 'reader' };
}

// The calendar picker's options for the DS Select: picker order (primary → owned → shared), with the
// group headers carried as each option's `group` — consecutive options sharing one render under it.
describe('googleCalendarSelectOptions', () => {
    it('lists the calendars in picker order', () => {
        const options = googleCalendarSelectOptions([
            cal('shared', 'Team', { accessRole: 'reader' }),
            cal('owned', 'Work', { accessRole: 'owner' }),
            cal('primary', 'Me', { primary: true }),
        ]);
        expect(options.map((option) => option.value)).toEqual(['primary', 'owned', 'shared']);
    });

    it('groups the owned and shared calendars under their headers; the primary stays ungrouped', () => {
        const options = googleCalendarSelectOptions([
            cal('primary', 'Me', { primary: true }),
            cal('owned', 'Work', { accessRole: 'owner' }),
            cal('shared', 'Team'),
        ]);
        expect(options.map((option) => option.group)).toEqual([undefined, 'Your calendars', 'Shared with you']);
    });

    it('omits the headers for a single homogeneous list', () => {
        const options = googleCalendarSelectOptions([cal('a', 'Alpha', { accessRole: 'owner' }), cal('b', 'Beta', { accessRole: 'owner' })]);
        expect(options.map((option) => option.group)).toEqual([undefined, undefined]);
    });

    it('marks only the primary calendar as primary in its label', () => {
        const options = googleCalendarSelectOptions([cal('primary', 'Me', { primary: true }), cal('work', 'Work', { accessRole: 'owner' })]);
        expect(options.map((option) => option.label)).toEqual(['Me (primary)', 'Work']);
    });

    it('returns no options for an empty calendar list', () => {
        expect(googleCalendarSelectOptions([])).toEqual([]);
    });
});
