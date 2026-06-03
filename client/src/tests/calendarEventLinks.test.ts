import { describe, expect, it } from 'vitest';
import { isUrl, meetingLinkLabel, resolveCalendarName } from '../components/itemEditor/CalendarEventLinks';
import type { CalendarOption } from '../hooks/useCalendarOptions';
import type { StoredItem } from '../types/MyDB';

function option(overrides: Partial<CalendarOption> = {}): CalendarOption {
    return {
        configId: 'cfg-1',
        integrationId: 'int-1',
        userId: 'user-1',
        accountEmail: 'me@example.com',
        displayName: 'Work',
        isDefault: false,
        ...overrides,
    };
}

function calendarItem(overrides: Partial<StoredItem> = {}): StoredItem {
    return {
        _id: 'item-1',
        userId: 'user-1',
        status: 'calendar',
        title: 'Standup',
        createdTs: '2026-06-01T00:00:00Z',
        updatedTs: '2026-06-01T00:00:00Z',
        ...overrides,
    } as StoredItem;
}

describe('meetingLinkLabel', () => {
    it('labels a Google Meet link', () => {
        expect(meetingLinkLabel('https://meet.google.com/abc-defg-hij')).toBe('Join Google Meet');
    });

    it('labels a Zoom link, including subdomains', () => {
        expect(meetingLinkLabel('https://zoom.us/j/123456789')).toBe('Join Zoom');
        expect(meetingLinkLabel('https://acme.zoom.us/j/987')).toBe('Join Zoom');
    });

    it('falls back to a generic label for other providers', () => {
        expect(meetingLinkLabel('https://teams.microsoft.com/l/meetup-join/xyz')).toBe('Join meeting');
    });

    it('falls back to a generic label when the URL is unparseable', () => {
        expect(meetingLinkLabel('not a url')).toBe('Join meeting');
    });
});

describe('isUrl', () => {
    it('returns true for http(s) URLs', () => {
        expect(isUrl('https://example.com')).toBe(true);
        expect(isUrl('http://example.com/path')).toBe(true);
    });

    it('returns false for plain-text locations', () => {
        expect(isUrl('Room 4B, HQ')).toBe(false);
        // A non-http protocol (e.g. tel:) is not a clickable location link here.
        expect(isUrl('tel:+1-555-0100')).toBe(false);
        // Empty string is unparseable → caught → false.
        expect(isUrl('')).toBe(false);
    });
});

describe('resolveCalendarName', () => {
    it('returns the matching calendar displayName', () => {
        const item = calendarItem({ calendarSyncConfigId: 'cfg-2' });
        const options = [option({ configId: 'cfg-1', displayName: 'Personal' }), option({ configId: 'cfg-2', displayName: 'Team' })];
        expect(resolveCalendarName(item, options)).toBe('Team');
    });

    it('falls back to the config id when no option matches (e.g. options not yet loaded)', () => {
        const item = calendarItem({ calendarSyncConfigId: 'cfg-unknown' });
        expect(resolveCalendarName(item, [option()])).toBe('cfg-unknown');
    });

    it('returns undefined when the item has no calendarSyncConfigId', () => {
        expect(resolveCalendarName(calendarItem(), [option()])).toBeUndefined();
    });
});
