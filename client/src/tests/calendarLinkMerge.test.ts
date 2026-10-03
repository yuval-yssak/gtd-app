/** `mergeServerOwnedCalendarFields`: the field-level exception to whole-row LWW that lets a pulled
 * (older) snapshot hand its server-stamped Google link to a newer local row. */
import { describe, expect, it } from 'vitest';
import { CALENDAR_LINK_FIELDS, CALENDAR_SYNC_ANCHOR_FIELDS, mergeServerOwnedCalendarFields } from '../db/calendarLinkMerge';
import type { StoredItem } from '../types/MyDB';

const base: StoredItem = {
    _id: 'item-1',
    userId: 'user-1',
    status: 'calendar',
    title: 'Demo: sync to Google Calendar',
    timeStart: '2026-09-28T10:00:00Z',
    timeEnd: '2026-09-28T11:00:00Z',
    createdTs: '2026-09-27T10:00:00.000Z',
    updatedTs: '2026-09-27T10:00:30.000Z',
};

const link = {
    calendarEventId: 'gtd-evt-1',
    calendarIntegrationId: 'integ-1',
    calendarSyncConfigId: 'cfg-1',
    htmlLink: 'https://calendar.google.com/event?eid=1',
};
const anchors = {
    lastPushedToGCalTs: '2026-09-27T10:00:05.000Z',
    lastSyncedNotes: '<p>notes</p>',
    lastSyncedFromGCalTs: '2026-09-27T10:00:05.000Z',
    calendarInstanceEventId: 'master_20260928T100000Z',
};

/** The server's link-stamp snapshot: older updatedTs, carries everything the client never saw. */
const linkStamp: StoredItem = { ...base, updatedTs: '2026-09-27T10:00:05.000Z', ...link, ...anchors };

describe('mergeServerOwnedCalendarFields', () => {
    it('adds the link + anchors to a newer local calendar row without touching its own fields', () => {
        const local = { ...base, status: 'done' as const, title: 'edited locally' };
        expect(mergeServerOwnedCalendarFields(local, linkStamp)).toEqual({ ...local, ...link, ...anchors });
    });

    it('merges into a newer trash row too (trash keeps the link so a revive relinks)', () => {
        expect(mergeServerOwnedCalendarFields({ ...base, status: 'trash' }, linkStamp)?.calendarEventId).toBe('gtd-evt-1');
    });

    it.each([
        'inbox',
        'nextAction',
        'waitingFor',
        'somedayMaybe',
    ] as const)('refuses to re-link a local %s row — the detach stripped the link on purpose', (status) => {
        expect(mergeServerOwnedCalendarFields({ ...base, status }, linkStamp)).toBeNull();
    });

    it('refuses to merge across owners — a reassigned row must not inherit the source account’s link', () => {
        expect(mergeServerOwnedCalendarFields({ ...base, userId: 'user-target' }, linkStamp)).toBeNull();
    });

    it('never overwrites a field the local row already has', () => {
        const local = { ...base, calendarEventId: 'gtd-evt-1', htmlLink: 'https://local/copy' };
        const merged = mergeServerOwnedCalendarFields(local, linkStamp);
        expect(merged?.htmlLink).toBe('https://local/copy');
        expect(merged?.calendarIntegrationId).toBe('integ-1');
    });

    it('merges nothing into a local row that names a DIFFERENT event — link and anchors all describe the old one', () => {
        expect(mergeServerOwnedCalendarFields({ ...base, calendarEventId: 'gtd-evt-2' }, linkStamp)).toBeNull();
    });

    it('merges nothing into a local row re-targeted to a DIFFERENT integration (no mixed-link rows)', () => {
        expect(mergeServerOwnedCalendarFields({ ...base, calendarIntegrationId: 'integ-2', calendarSyncConfigId: 'cfg-2' }, linkStamp)).toBeNull();
    });

    it('merges anchors field by field when the incoming snapshot carries no link at all', () => {
        const anchorsOnly = { ...base, updatedTs: '2026-09-27T10:00:05.000Z', lastSyncedFromGCalTs: anchors.lastSyncedFromGCalTs };
        expect(mergeServerOwnedCalendarFields(base, anchorsOnly)).toEqual({ ...base, lastSyncedFromGCalTs: anchors.lastSyncedFromGCalTs });
    });

    it('returns null when the incoming snapshot brings nothing new', () => {
        expect(mergeServerOwnedCalendarFields(linkStamp, base)).toBeNull();
        expect(mergeServerOwnedCalendarFields(base, base)).toBeNull();
    });

    it('ignores client-owned fields on the incoming snapshot (title, times, notes stay local)', () => {
        const merged = mergeServerOwnedCalendarFields({ ...base, title: 'local' }, { ...linkStamp, title: 'server', notes: 'server notes' });
        expect(merged?.title).toBe('local');
        expect(merged?.notes).toBeUndefined();
    });

    it('parity pin — the SAME literals live in api-server/src/tests/calendarLinkCarryForward.test.ts; change both together', () => {
        expect(CALENDAR_LINK_FIELDS).toEqual(['calendarEventId', 'calendarIntegrationId', 'calendarSyncConfigId', 'htmlLink']);
        expect(CALENDAR_SYNC_ANCHOR_FIELDS).toEqual(['calendarInstanceEventId', 'lastPushedToGCalTs', 'lastSyncedNotes', 'lastSyncedFromGCalTs']);
    });
});
