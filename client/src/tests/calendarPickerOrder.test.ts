import { describe, expect, it } from 'vitest';
import type { GoogleCalendar } from '../api/calendarApi';
import { buildCalendarPickerRows, defaultCalendarId, sortCalendars } from '../components/settings/calendarPickerOrder';

function cal(id: string, name: string, opts?: { primary?: boolean; accessRole?: string }): GoogleCalendar {
    return { id, name, primary: opts?.primary ?? false, accessRole: opts?.accessRole ?? 'reader' };
}

describe('sortCalendars', () => {
    it('orders primary first, then owned, then shared', () => {
        const input = [
            cal('shared-z', 'Zoo', { accessRole: 'reader' }),
            cal('owned-b', 'Birthdays', { accessRole: 'owner' }),
            cal('primary', 'My Calendar', { primary: true, accessRole: 'owner' }),
            cal('owned-a', 'Admin', { accessRole: 'writer' }),
            cal('shared-a', 'Alpha', { accessRole: 'freeBusyReader' }),
        ];
        expect(sortCalendars(input).map((c) => c.id)).toEqual(['primary', 'owned-a', 'owned-b', 'shared-a', 'shared-z']);
    });

    it('sorts alphabetically case-insensitively within a group', () => {
        const input = [cal('b', 'banana', { accessRole: 'owner' }), cal('a', 'Apple', { accessRole: 'owner' }), cal('c', 'cherry', { accessRole: 'owner' })];
        expect(sortCalendars(input).map((c) => c.name)).toEqual(['Apple', 'banana', 'cherry']);
    });

    it('treats owner and writer as owned, reader and freeBusyReader as shared', () => {
        const input = [
            cal('writer', 'Writer', { accessRole: 'writer' }),
            cal('freeBusy', 'FreeBusy', { accessRole: 'freeBusyReader' }),
            cal('owner', 'Owner', { accessRole: 'owner' }),
            cal('reader', 'Reader', { accessRole: 'reader' }),
        ];
        // owned group (Owner, Writer A–Z) precedes shared group (FreeBusy, Reader A–Z)
        expect(sortCalendars(input).map((c) => c.id)).toEqual(['owner', 'writer', 'freeBusy', 'reader']);
    });

    it('does not mutate the input array', () => {
        const input = [cal('b', 'B', { accessRole: 'owner' }), cal('a', 'A', { primary: true })];
        const snapshot = input.map((c) => c.id);
        sortCalendars(input);
        expect(input.map((c) => c.id)).toEqual(snapshot);
    });

    it('returns an empty array for no calendars', () => {
        expect(sortCalendars([])).toEqual([]);
    });
});

describe('defaultCalendarId', () => {
    it('returns the primary calendar id when present, regardless of input order', () => {
        const input = [cal('work', 'Work', { accessRole: 'owner' }), cal('primary', 'Me', { primary: true })];
        expect(defaultCalendarId(input)).toBe('primary');
    });

    it('falls back to the first sorted calendar when there is no primary', () => {
        const input = [cal('z', 'Zeta', { accessRole: 'owner' }), cal('a', 'Alpha', { accessRole: 'owner' })];
        expect(defaultCalendarId(input)).toBe('a');
    });

    it('returns undefined for an empty list', () => {
        expect(defaultCalendarId([])).toBeUndefined();
    });
});

describe('buildCalendarPickerRows', () => {
    it('inserts group headers before owned and shared sections when multiple groups exist', () => {
        const input = [cal('primary', 'Me', { primary: true }), cal('owned', 'Work', { accessRole: 'owner' }), cal('shared', 'Team', { accessRole: 'reader' })];
        expect(buildCalendarPickerRows(input)).toEqual([
            { kind: 'calendar', calendar: input[0] },
            { kind: 'header', key: 'owned', label: 'Your calendars' },
            { kind: 'calendar', calendar: input[1] },
            { kind: 'header', key: 'shared', label: 'Shared with you' },
            { kind: 'calendar', calendar: input[2] },
        ]);
    });

    it('omits headers entirely when only one group is present', () => {
        const input = [cal('a', 'Apple', { accessRole: 'owner' }), cal('b', 'Banana', { accessRole: 'owner' })];
        const rows = buildCalendarPickerRows(input);
        expect(rows.every((r) => r.kind === 'calendar')).toBe(true);
        expect(rows).toHaveLength(2);
    });

    it('never emits a header for the primary group', () => {
        const input = [cal('primary', 'Me', { primary: true }), cal('shared', 'Team', { accessRole: 'reader' })];
        const headers = buildCalendarPickerRows(input).filter((r) => r.kind === 'header');
        expect(headers.map((h) => (h.kind === 'header' ? h.key : null))).toEqual(['shared']);
    });

    it('returns no rows for an empty list', () => {
        expect(buildCalendarPickerRows([])).toEqual([]);
    });
});
