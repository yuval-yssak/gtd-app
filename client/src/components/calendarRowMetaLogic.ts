/**
 * Pure helpers behind CalendarRowMeta. Extracted into a render-free module so it can be unit-tested
 * under vitest's `environment: 'node'` (the project lacks jsdom — see vitest.config.ts). The
 * component itself owns rendering; these helpers cover the data transforms that drive it.
 */
import type { GCalResponseStatus, StoredItem } from '../types/MyDB';

/**
 * Decides whether to mount the meta row at all. Returns false when the item carries neither
 * attendees nor an organizer — the caller can render `<CalendarRowMeta />` unconditionally and
 * have it self-suppress through this helper.
 */
export function shouldRenderMeta(item: StoredItem): boolean {
    const hasAttendees = (item.attendees?.length ?? 0) > 0;
    const hasOrganizer = Boolean(item.organizer);
    return hasAttendees || hasOrganizer;
}

/**
 * The visible label for the organizer slot. Prefers `displayName`, falls back to `email`, and
 * returns undefined when there is no organizer at all — the caller hides the slot in that case.
 */
export function getOrganizerDisplay(item: StoredItem): string | undefined {
    const organizer = item.organizer;
    if (!organizer) return undefined;
    return organizer.displayName ?? organizer.email;
}

/**
 * The self attendee's responseStatus, or undefined when no self attendee exists (e.g. personal
 * event with no invites). The row uses this to render the small RSVP dot.
 */
export function getSelfResponseStatus(item: StoredItem): GCalResponseStatus | undefined {
    const attendees = item.attendees ?? [];
    const self = attendees.find((a) => a.self === true);
    return self?.responseStatus;
}

/** Attendee count for the people icon. Returns 0 (not undefined) so the renderer can short-circuit on falsy. */
export function getAttendeeCount(item: StoredItem): number {
    return item.attendees?.length ?? 0;
}

/**
 * Maps a GCal response status to the MUI palette color used for the RSVP dot. `needsAction`
 * intentionally falls through to a neutral gray ("no answer" visual).
 */
export function rsvpDotColorFor(status: GCalResponseStatus): 'success' | 'error' | 'warning' | 'default' {
    if (status === 'accepted') return 'success';
    if (status === 'declined') return 'error';
    if (status === 'tentative') return 'warning';
    return 'default';
}
