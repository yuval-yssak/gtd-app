/**
 * Pure helper for deciding when the SendUpdatesDialog must fire before saving a calendar item.
 * Lives outside the component so the rule is unit-testable under vitest's node environment.
 *
 * The dialog only fires when **all** of:
 *  - the (post-edit) status is `calendar`,
 *  - the item has at least one attendee,
 *  - and at least one meeting-relevant field changed between before/after.
 *
 * Meeting-relevant fields per Phase 6 spec: title, timeStart, timeEnd, allDay, attendees, notes.
 * Routine-generated calendar items count too — the routine-instance edit path uses the same gate.
 */
import type { GCalAttendee, StoredItem } from '../../types/MyDB';

/** Subset of StoredItem fields the dialog cares about. Caller can build this from a form or a merged item. */
export interface MeetingDiffInput {
    status: StoredItem['status'];
    title: string;
    notes: string | undefined;
    timeStart: string | undefined;
    timeEnd: string | undefined;
    allDay: boolean | undefined;
    attendees: GCalAttendee[] | undefined;
}

/**
 * Compares two attendee arrays by the fields that affect a notification round-trip: email and
 * responseStatus. (Display-name-only changes don't warrant a re-notification.) Order is normalised
 * via a sorted key list because GCal returns attendees sorted by email and the inbound parser
 * preserves that order; an out-of-order local mutation should still register as "same set".
 */
function attendeesDiffer(a: GCalAttendee[] | undefined, b: GCalAttendee[] | undefined): boolean {
    const left = a ?? [];
    const right = b ?? [];
    if (left.length !== right.length) return true;
    const keyOf = (x: GCalAttendee) => `${x.email.toLowerCase()}|${x.responseStatus}`;
    const leftKeys = left.map(keyOf).sort();
    const rightKeys = right.map(keyOf).sort();
    return leftKeys.some((k, i) => k !== rightKeys[i]);
}

export function shouldFireSendUpdatesDialog(before: MeetingDiffInput, after: MeetingDiffInput): boolean {
    if (after.status !== 'calendar') {
        return false;
    }
    const attendeeCount = after.attendees?.length ?? 0;
    if (attendeeCount === 0) {
        return false;
    }
    if (before.title !== after.title) return true;
    if ((before.notes ?? '') !== (after.notes ?? '')) return true;
    if (before.timeStart !== after.timeStart) return true;
    if (before.timeEnd !== after.timeEnd) return true;
    if (Boolean(before.allDay) !== Boolean(after.allDay)) return true;
    return attendeesDiffer(before.attendees, after.attendees);
}
