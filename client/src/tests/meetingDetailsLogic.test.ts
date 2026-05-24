/**
 * Unit tests for the pure helpers behind the MeetingDetails component. Render-level tests are
 * intentionally omitted — the client uses vitest's `environment: 'node'` (see vitest.config.ts) so
 * there's no jsdom; render-free coverage of the underlying transforms is what we have.
 */
import { describe, expect, it } from 'vitest';
import {
    addAttendeeByEmail,
    applyOptimisticRsvp,
    countResponseStatuses,
    filterPeopleForAutocomplete,
    findPersonByEmail,
    findSelfAttendee,
    formatResponseSummary,
    isPlausibleEmail,
    removeAttendeeByEmail,
} from '../components/itemEditor/meetingDetailsLogic';
import type { GCalAttendee, StoredPerson } from '../types/MyDB';

function attendee(email: string, responseStatus: GCalAttendee['responseStatus'] = 'needsAction', extras: Partial<GCalAttendee> = {}): GCalAttendee {
    return { email, responseStatus, ...extras };
}

function person(id: string, name: string, email?: string): StoredPerson {
    const base = {
        _id: id,
        userId: 'user-1',
        name,
        createdTs: '2026-01-01T00:00:00.000Z',
        updatedTs: '2026-01-01T00:00:00.000Z',
    };
    return email ? { ...base, email } : base;
}

describe('countResponseStatuses', () => {
    it('returns all-zero counts for an empty list', () => {
        expect(countResponseStatuses([])).toEqual({ accepted: 0, declined: 0, tentative: 0, needsAction: 0 });
    });

    it('counts a single bucket when every attendee has the same response', () => {
        const attendees = [attendee('a@x.com', 'accepted'), attendee('b@x.com', 'accepted')];
        expect(countResponseStatuses(attendees)).toEqual({ accepted: 2, declined: 0, tentative: 0, needsAction: 0 });
    });

    it('tallies a mixed list across all four buckets', () => {
        const attendees = [
            attendee('a@x.com', 'accepted'),
            attendee('b@x.com', 'declined'),
            attendee('c@x.com', 'tentative'),
            attendee('d@x.com', 'needsAction'),
            attendee('e@x.com', 'accepted'),
        ];
        expect(countResponseStatuses(attendees)).toEqual({ accepted: 2, declined: 1, tentative: 1, needsAction: 1 });
    });
});

describe('formatResponseSummary', () => {
    it('returns an empty string when there are no attendees', () => {
        expect(formatResponseSummary([])).toBe('');
    });

    it('omits zero-buckets when every attendee accepted', () => {
        const attendees = [attendee('a@x.com', 'accepted'), attendee('b@x.com', 'accepted'), attendee('c@x.com', 'accepted')];
        expect(formatResponseSummary(attendees)).toBe('3 accepted');
    });

    it('joins the populated buckets with a dot separator in the canonical order', () => {
        // Canonical order: accepted, declined, tentative, pending — matches the summary spec
        const attendees = [
            attendee('a@x.com', 'accepted'),
            attendee('b@x.com', 'accepted'),
            attendee('c@x.com', 'accepted'),
            attendee('d@x.com', 'declined'),
            attendee('e@x.com', 'needsAction'),
        ];
        expect(formatResponseSummary(attendees)).toBe('3 accepted · 1 declined · 1 pending');
    });

    it('renders only the pending bucket when no one has answered yet', () => {
        const attendees = [attendee('a@x.com', 'needsAction'), attendee('b@x.com', 'needsAction')];
        expect(formatResponseSummary(attendees)).toBe('2 pending');
    });
});

describe('removeAttendeeByEmail', () => {
    it('returns the array unchanged when the email is not present', () => {
        const attendees = [attendee('a@x.com'), attendee('b@x.com')];
        const result = removeAttendeeByEmail(attendees, 'missing@x.com');
        expect(result).toHaveLength(2);
        expect(result.map((a) => a.email)).toEqual(['a@x.com', 'b@x.com']);
    });

    it('removes the matching attendee (case-insensitive)', () => {
        const attendees = [attendee('Alice@X.com'), attendee('bob@x.com')];
        const result = removeAttendeeByEmail(attendees, 'alice@x.com');
        expect(result).toHaveLength(1);
        expect(result[0]?.email).toBe('bob@x.com');
    });

    it('does not mutate the original array', () => {
        const attendees = [attendee('a@x.com'), attendee('b@x.com')];
        removeAttendeeByEmail(attendees, 'a@x.com');
        expect(attendees).toHaveLength(2);
    });
});

describe('applyOptimisticRsvp', () => {
    it('updates the self attendee responseStatus in place', () => {
        const attendees = [attendee('self@x.com', 'needsAction', { self: true }), attendee('other@x.com', 'accepted')];
        const result = applyOptimisticRsvp(attendees, 'self@x.com', 'declined');
        expect(result).toHaveLength(2);
        const [selfRow, otherRow] = result;
        expect(selfRow?.responseStatus).toBe('declined');
        expect(otherRow?.responseStatus).toBe('accepted');
    });

    it('appends a self entry when none exists (parser dropped it)', () => {
        const attendees = [attendee('other@x.com')];
        const result = applyOptimisticRsvp(attendees, 'self@x.com', 'accepted');
        expect(result).toHaveLength(2);
        const selfRow = result.find((a) => a.email === 'self@x.com');
        expect(selfRow?.responseStatus).toBe('accepted');
        expect(selfRow?.self).toBe(true);
    });
});

describe('findSelfAttendee', () => {
    it('returns the self attendee when present', () => {
        const attendees = [attendee('other@x.com'), attendee('self@x.com', 'accepted', { self: true })];
        expect(findSelfAttendee(attendees)?.email).toBe('self@x.com');
    });

    it('returns undefined when no attendee carries self: true', () => {
        expect(findSelfAttendee([attendee('a@x.com'), attendee('b@x.com')])).toBeUndefined();
    });
});

describe('findPersonByEmail', () => {
    const people = [person('p1', 'Alice', 'alice@x.com'), person('p2', 'Bob', 'BOB@X.com'), person('p3', 'Carol')];

    it('matches case-insensitively', () => {
        expect(findPersonByEmail(people, 'ALICE@X.COM')?._id).toBe('p1');
        expect(findPersonByEmail(people, 'bob@x.com')?._id).toBe('p2');
    });

    it('returns undefined for missing email', () => {
        expect(findPersonByEmail(people, 'nobody@x.com')).toBeUndefined();
    });

    it('does not surface a person without an email for a real email lookup', () => {
        // Carol has no email — a lookup of any concrete address must skip her even though her stored
        // email is `undefined` (the helper coerces missing emails to '' but the query is the address).
        expect(findPersonByEmail(people, 'something@x.com')).toBeUndefined();
    });
});

describe('filterPeopleForAutocomplete', () => {
    const people = [person('p1', 'Alice Adams', 'alice@example.com'), person('p2', 'Bob Bee', 'bob@other.com'), person('p3', 'Carol Cat')];

    it('returns the full roster on empty query', () => {
        expect(filterPeopleForAutocomplete(people, '')).toHaveLength(3);
        expect(filterPeopleForAutocomplete(people, '   ')).toHaveLength(3);
    });

    it('matches case-insensitively against name', () => {
        const result = filterPeopleForAutocomplete(people, 'ALICE');
        expect(result.map((p) => p._id)).toEqual(['p1']);
    });

    it('matches case-insensitively against email substring', () => {
        const result = filterPeopleForAutocomplete(people, '@example');
        expect(result.map((p) => p._id)).toEqual(['p1']);
    });

    it('surfaces people without email when their name matches', () => {
        // Carol has no email; a name-prefix query should still find her
        const result = filterPeopleForAutocomplete(people, 'carol');
        expect(result.map((p) => p._id)).toEqual(['p3']);
    });
});

describe('isPlausibleEmail', () => {
    it('accepts standard addresses', () => {
        expect(isPlausibleEmail('a@b.com')).toBe(true);
        expect(isPlausibleEmail('user+tag@subdomain.example.com')).toBe(true);
    });

    it('rejects empty/blank inputs', () => {
        expect(isPlausibleEmail('')).toBe(false);
        expect(isPlausibleEmail('   ')).toBe(false);
    });

    it('rejects strings missing an @ or a domain dot', () => {
        expect(isPlausibleEmail('alice')).toBe(false);
        expect(isPlausibleEmail('alice@')).toBe(false);
        expect(isPlausibleEmail('alice@nope')).toBe(false);
    });
});

describe('addAttendeeByEmail', () => {
    it('appends a fresh needsAction attendee when the email is new', () => {
        const result = addAttendeeByEmail([attendee('a@x.com', 'accepted')], 'b@x.com', 'Bob');
        expect(result).toHaveLength(2);
        const bob = result.find((a) => a.email === 'b@x.com');
        expect(bob?.responseStatus).toBe('needsAction');
        expect(bob?.displayName).toBe('Bob');
    });

    it('omits displayName when blank', () => {
        const result = addAttendeeByEmail([], 'b@x.com');
        const bob = result[0];
        expect(bob?.displayName).toBeUndefined();
    });

    it('returns the original array when the email is already an attendee (case-insensitive)', () => {
        const original = [attendee('Alice@X.com', 'accepted')];
        const result = addAttendeeByEmail(original, 'alice@x.com');
        expect(result).toBe(original);
    });
});
