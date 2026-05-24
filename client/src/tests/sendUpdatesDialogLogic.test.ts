/**
 * Unit tests for `shouldFireSendUpdatesDialog` — the gate that decides whether the organizer
 * must be prompted before a save can push notification-worthy changes to GCal attendees.
 *
 * Lives outside the component for the same reason as meetingDetailsLogic: the project runs vitest
 * under `environment: 'node'` with no jsdom shim, so render-level tests aren't viable.
 */
import { describe, expect, it } from 'vitest';
import { type MeetingDiffInput, shouldFireSendUpdatesDialog } from '../components/itemEditor/sendUpdatesDialogLogic';
import type { GCalAttendee } from '../types/MyDB';

const SELF_ATTENDEE: GCalAttendee = { email: 'self@x.com', responseStatus: 'accepted', self: true };
const OTHER_ATTENDEE: GCalAttendee = { email: 'other@x.com', responseStatus: 'needsAction' };

function makeInput(overrides: Partial<MeetingDiffInput> = {}): MeetingDiffInput {
    return {
        status: 'calendar',
        title: 'Standup',
        notes: 'agenda',
        timeStart: '2026-05-04T09:00:00.000Z',
        timeEnd: '2026-05-04T09:30:00.000Z',
        allDay: false,
        attendees: [SELF_ATTENDEE, OTHER_ATTENDEE],
        ...overrides,
    };
}

describe('shouldFireSendUpdatesDialog', () => {
    it('returns false when the new status is not calendar', () => {
        const before = makeInput();
        const after = makeInput({ status: 'inbox' });
        expect(shouldFireSendUpdatesDialog(before, after)).toBe(false);
    });

    it('returns false when there are no attendees post-edit', () => {
        const before = makeInput({ attendees: [] });
        const after = makeInput({ attendees: [], title: 'Changed' });
        expect(shouldFireSendUpdatesDialog(before, after)).toBe(false);
    });

    it('returns true on a title change with attendees present', () => {
        const before = makeInput();
        const after = makeInput({ title: 'New title' });
        expect(shouldFireSendUpdatesDialog(before, after)).toBe(true);
    });

    it('returns true on a notes change with attendees present', () => {
        const before = makeInput({ notes: 'old' });
        const after = makeInput({ notes: 'new agenda' });
        expect(shouldFireSendUpdatesDialog(before, after)).toBe(true);
    });

    it('returns true on a timeStart change', () => {
        const before = makeInput();
        const after = makeInput({ timeStart: '2026-05-04T10:00:00.000Z' });
        expect(shouldFireSendUpdatesDialog(before, after)).toBe(true);
    });

    it('returns true on a timeEnd change', () => {
        const before = makeInput();
        const after = makeInput({ timeEnd: '2026-05-04T11:00:00.000Z' });
        expect(shouldFireSendUpdatesDialog(before, after)).toBe(true);
    });

    it('returns true when toggling allDay', () => {
        const before = makeInput();
        const after = makeInput({ allDay: true });
        expect(shouldFireSendUpdatesDialog(before, after)).toBe(true);
    });

    it('returns true when an attendee is added', () => {
        const before = makeInput({ attendees: [SELF_ATTENDEE] });
        const after = makeInput({ attendees: [SELF_ATTENDEE, OTHER_ATTENDEE] });
        expect(shouldFireSendUpdatesDialog(before, after)).toBe(true);
    });

    it('returns true when an attendee responseStatus changes', () => {
        const before = makeInput({ attendees: [SELF_ATTENDEE, OTHER_ATTENDEE] });
        const after = makeInput({ attendees: [SELF_ATTENDEE, { ...OTHER_ATTENDEE, responseStatus: 'accepted' }] });
        expect(shouldFireSendUpdatesDialog(before, after)).toBe(true);
    });

    it('treats attendee re-ordering as equivalent (the parser sorts by email)', () => {
        // Same set of emails + statuses but in a different array order — must not fire.
        const before = makeInput({ attendees: [SELF_ATTENDEE, OTHER_ATTENDEE] });
        const after = makeInput({ attendees: [OTHER_ATTENDEE, SELF_ATTENDEE] });
        expect(shouldFireSendUpdatesDialog(before, after)).toBe(false);
    });

    it('returns false when nothing meaningful changed', () => {
        const before = makeInput();
        const after = makeInput();
        expect(shouldFireSendUpdatesDialog(before, after)).toBe(false);
    });

    it('treats absent vs falsy allDay as equivalent (no notification-worthy diff)', () => {
        const before = makeInput({ allDay: undefined });
        const after = makeInput({ allDay: false });
        expect(shouldFireSendUpdatesDialog(before, after)).toBe(false);
    });
});
