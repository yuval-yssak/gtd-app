/**
 * Pure helpers for the MeetingDetails component. Extracted into its own module so they can be
 * unit-tested under vitest's `environment: 'node'` (the project lacks jsdom — see vitest.config.ts).
 * The component itself owns rendering; these helpers cover the data transforms that drive it.
 */
import type { GCalAttendee, GCalResponseStatus, StoredPerson } from '../../types/MyDB';

export interface ResponseCounts {
    accepted: number;
    declined: number;
    tentative: number;
    needsAction: number;
}

export function countResponseStatuses(attendees: GCalAttendee[]): ResponseCounts {
    // Tally via four counts(.filter().length) calls — declarative, avoids the spread-in-reduce
    // anti-pattern Biome flags, and stays trivially correct because each filter is independent.
    return {
        accepted: attendees.filter((a) => a.responseStatus === 'accepted').length,
        declined: attendees.filter((a) => a.responseStatus === 'declined').length,
        tentative: attendees.filter((a) => a.responseStatus === 'tentative').length,
        needsAction: attendees.filter((a) => a.responseStatus === 'needsAction').length,
    };
}

/**
 * Renders the aggregate-count summary shown in the accordion header.
 * Empty input → empty string so the caller can suppress the dot separator.
 * Zero-buckets are omitted to keep the string short ("3 accepted" not "3 accepted · 0 declined · 0 pending").
 */
export function formatResponseSummary(attendees: GCalAttendee[]): string {
    const counts = countResponseStatuses(attendees);
    const parts: string[] = [];
    if (counts.accepted > 0) parts.push(`${counts.accepted} accepted`);
    if (counts.declined > 0) parts.push(`${counts.declined} declined`);
    if (counts.tentative > 0) parts.push(`${counts.tentative} tentative`);
    if (counts.needsAction > 0) parts.push(`${counts.needsAction} pending`);
    return parts.join(' · ');
}

/** Removes the attendee with the matching email (case-insensitive). Returns a new array. */
export function removeAttendeeByEmail(attendees: GCalAttendee[], targetEmail: string): GCalAttendee[] {
    const lowered = targetEmail.toLowerCase();
    return attendees.filter((a) => a.email.toLowerCase() !== lowered);
}

/**
 * Replaces the responseStatus on the self attendee (or appends a self entry if none exists).
 * Mirrors what the server does on RSVP — used here for the optimistic UI flip before the
 * server response (or the queued op) lands.
 */
export function applyOptimisticRsvp(attendees: GCalAttendee[], selfEmail: string, next: GCalResponseStatus): GCalAttendee[] {
    const lowered = selfEmail.toLowerCase();
    const found = attendees.some((a) => a.email.toLowerCase() === lowered);
    if (!found) {
        // Fallback — if the server's parser dropped the self attendee (rare), seed one rather than
        // leaving the chip stuck on the old colour. The next inbound pull rewrites the array anyway.
        return [...attendees, { email: selfEmail, self: true, responseStatus: next }];
    }
    return attendees.map((a) => (a.email.toLowerCase() === lowered ? { ...a, responseStatus: next } : a));
}

/**
 * Locates the self attendee. Per the GCal data model exactly one attendee may carry `self: true`;
 * we return the first match for defensive parsing.
 */
export function findSelfAttendee(attendees: GCalAttendee[]): GCalAttendee | undefined {
    return attendees.find((a) => a.self === true);
}

/** Looks up a person by email (case-insensitive). Used to surface a Link affordance on attendee chips. */
export function findPersonByEmail(people: StoredPerson[], email: string): StoredPerson | undefined {
    const lowered = email.toLowerCase();
    return people.find((p) => (p.email ?? '').toLowerCase() === lowered);
}

/**
 * Filters the people roster for the attendee autocomplete. Matches case-insensitive substrings
 * against BOTH name and email so a typed "@example.com" surfaces every emailed contact and a
 * typed first-name surfaces the named ones. People without an email are still surfaced — the UI
 * exposes an inline "add email" prompt before they can become attendees.
 */
export function filterPeopleForAutocomplete(people: StoredPerson[], query: string): StoredPerson[] {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) {
        return people;
    }
    return people.filter((p) => {
        const nameMatch = p.name.toLowerCase().includes(trimmed);
        const emailMatch = (p.email ?? '').toLowerCase().includes(trimmed);
        return nameMatch || emailMatch;
    });
}

/**
 * RFC-5322-lite email shape check. Used only to decide whether free-text input may be committed
 * as an attendee; the source of truth for validity is the server.
 */
export function isPlausibleEmail(value: string): boolean {
    const trimmed = value.trim();
    if (trimmed.length === 0) return false;
    // Single @ with at least one char on each side and a dot in the domain — covers the common
    // shape without trying to be a full RFC parser.
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

/**
 * Appends a new attendee (`needsAction` by default) to the existing list, deduping case-insensitively
 * by email. Returns the original array when the email was already present so the caller can detect
 * a no-op without comparing array references.
 */
export function addAttendeeByEmail(attendees: GCalAttendee[], email: string, displayName?: string): GCalAttendee[] {
    const lowered = email.toLowerCase();
    if (attendees.some((a) => a.email.toLowerCase() === lowered)) {
        return attendees;
    }
    // exactOptionalPropertyTypes-friendly construction — omit displayName when blank.
    const next: GCalAttendee = displayName?.trim()
        ? { email, displayName: displayName.trim(), responseStatus: 'needsAction' }
        : { email, responseStatus: 'needsAction' };
    return [...attendees, next];
}

/**
 * Detects whether a proposed attendee mutation changes the membership of the set (someone added
 * or removed) rather than just flipping the self responseStatus (RSVP). Used by the routine-instance
 * detach-warning gate so RSVP clicks bypass the dialog.
 *
 * Considers a change "membership" when the set of emails (case-insensitive) differs in either
 * direction. responseStatus / displayName flips do not count.
 */
export function isAttendeeMembershipChange(prev: GCalAttendee[], next: GCalAttendee[]): boolean {
    const prevEmails = new Set(prev.map((a) => a.email.toLowerCase()));
    const nextEmails = new Set(next.map((a) => a.email.toLowerCase()));
    if (prevEmails.size !== nextEmails.size) {
        return true;
    }
    for (const email of prevEmails) {
        if (!nextEmails.has(email)) {
            return true;
        }
    }
    return false;
}
