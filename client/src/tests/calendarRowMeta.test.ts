/**
 * Unit tests for the pure helpers behind CalendarRowMeta. Render-free coverage — see vitest.config.ts
 * (no jsdom). The mobile vs desktop branch belongs to the component; the helpers here cover the
 * shouldRenderMeta, getOrganizerDisplay, getSelfResponseStatus, getAttendeeCount, and dot-color
 * transforms that drive the visible markup.
 */
import { describe, expect, it } from 'vitest';
import { getAttendeeCount, getOrganizerDisplay, getSelfResponseStatus, rsvpDotColorFor, shouldRenderMeta } from '../components/calendarRowMetaLogic';
import type { GCalAttendee, GCalPerson, StoredItem } from '../types/MyDB';

function makeItem(overrides: Partial<StoredItem> = {}): StoredItem {
    return {
        _id: 'i1',
        userId: 'user-1',
        status: 'calendar',
        title: 'Demo',
        createdTs: '2026-05-23T00:00:00.000Z',
        updatedTs: '2026-05-23T00:00:00.000Z',
        ...overrides,
    };
}

function attendee(email: string, responseStatus: GCalAttendee['responseStatus'] = 'needsAction', extras: Partial<GCalAttendee> = {}): GCalAttendee {
    return { email, responseStatus, ...extras };
}

function organizer(email: string, displayName?: string): GCalPerson {
    return displayName ? { email, displayName } : { email };
}

describe('shouldRenderMeta', () => {
    it('returns false when the item has neither attendees nor organizer', () => {
        expect(shouldRenderMeta(makeItem())).toBe(false);
    });

    it('returns true when the item has attendees but no organizer', () => {
        expect(shouldRenderMeta(makeItem({ attendees: [attendee('a@x.com')] }))).toBe(true);
    });

    it('returns true when the item has an organizer but no attendees', () => {
        expect(shouldRenderMeta(makeItem({ organizer: organizer('o@x.com') }))).toBe(true);
    });

    it('returns false when attendees is an empty array and no organizer', () => {
        expect(shouldRenderMeta(makeItem({ attendees: [] }))).toBe(false);
    });
});

describe('getOrganizerDisplay', () => {
    it('returns undefined when there is no organizer', () => {
        expect(getOrganizerDisplay(makeItem())).toBeUndefined();
    });

    it('prefers displayName when set', () => {
        const item = makeItem({ organizer: organizer('alice@x.com', 'Alice Adams') });
        expect(getOrganizerDisplay(item)).toBe('Alice Adams');
    });

    it('falls back to email when displayName is absent', () => {
        const item = makeItem({ organizer: organizer('alice@x.com') });
        expect(getOrganizerDisplay(item)).toBe('alice@x.com');
    });
});

describe('getSelfResponseStatus', () => {
    it('returns undefined when there are no attendees', () => {
        expect(getSelfResponseStatus(makeItem())).toBeUndefined();
    });

    it('returns undefined when no attendee is self', () => {
        const item = makeItem({ attendees: [attendee('a@x.com'), attendee('b@x.com')] });
        expect(getSelfResponseStatus(item)).toBeUndefined();
    });

    it('returns the self attendee responseStatus', () => {
        const item = makeItem({
            attendees: [attendee('a@x.com', 'accepted'), attendee('me@x.com', 'declined', { self: true })],
        });
        expect(getSelfResponseStatus(item)).toBe('declined');
    });
});

describe('getAttendeeCount', () => {
    it('returns 0 when attendees is undefined', () => {
        expect(getAttendeeCount(makeItem())).toBe(0);
    });

    it('returns 0 for an empty list', () => {
        expect(getAttendeeCount(makeItem({ attendees: [] }))).toBe(0);
    });

    it('returns the length when populated', () => {
        const item = makeItem({ attendees: [attendee('a@x.com'), attendee('b@x.com'), attendee('c@x.com')] });
        expect(getAttendeeCount(item)).toBe(3);
    });
});

describe('rsvpDotColorFor', () => {
    it('maps accepted to success', () => {
        expect(rsvpDotColorFor('accepted')).toBe('success');
    });

    it('maps declined to error', () => {
        expect(rsvpDotColorFor('declined')).toBe('error');
    });

    it('maps tentative to warning', () => {
        expect(rsvpDotColorFor('tentative')).toBe('warning');
    });

    it('maps needsAction to default (neutral gray)', () => {
        expect(rsvpDotColorFor('needsAction')).toBe('default');
    });
});
