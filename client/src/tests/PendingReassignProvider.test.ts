import { describe, expect, it } from 'vitest';
import { applyOverrideToItem, applyOverrideToRoutine, type PendingReassignOverride } from '../contexts/PendingReassignProvider';
import type { StoredItem, StoredRoutine } from '../types/MyDB';

const ITEM: StoredItem = {
    _id: 'item-1',
    userId: 'user-A',
    status: 'calendar',
    title: 'Standup',
    createdTs: '2026-01-01T00:00:00.000Z',
    updatedTs: '2026-01-01T00:00:00.000Z',
    timeStart: '2026-05-01T09:00:00.000Z',
    timeEnd: '2026-05-01T09:30:00.000Z',
    calendarEventId: 'gcal-evt-1',
    calendarIntegrationId: 'int-A',
    calendarSyncConfigId: 'cfg-A',
};

const ROUTINE: StoredRoutine = {
    _id: 'r-1',
    userId: 'user-A',
    title: 'Daily standup',
    routineType: 'calendar',
    rrule: 'FREQ=DAILY',
    template: {},
    active: true,
    createdTs: '2026-01-01T00:00:00.000Z',
    updatedTs: '2026-01-01T00:00:00.000Z',
    calendarEventId: 'gcal-master-1',
    calendarIntegrationId: 'int-A',
    calendarSyncConfigId: 'cfg-A',
};

// The overlay is the contract that lets every list view reflect a cross-account reassign before
// /sync/reassign returns. The exact field rewriting is the contract we lock in here:
// - userId always flips (so unified-account filters move the row)
// - calendarIntegrationId/calendarSyncConfigId flip when provided (so calendar views land it
//   under the target account's calendar)
// - identity fields (`_id`, `calendarEventId`) MUST NOT change — overwriting calendarEventId
//   would create a phantom event-id mismatch when the SSE pull lands the real new id.
describe('applyOverrideToItem', () => {
    it('rewrites userId to the override target', () => {
        const override: PendingReassignOverride = { toUserId: 'user-B' };
        expect(applyOverrideToItem(ITEM, override).userId).toBe('user-B');
    });

    it('rewrites calendarIntegrationId and calendarSyncConfigId when provided', () => {
        const override: PendingReassignOverride = { toUserId: 'user-B', targetIntegrationId: 'int-B', targetSyncConfigId: 'cfg-B' };
        const out = applyOverrideToItem(ITEM, override);
        expect(out.calendarIntegrationId).toBe('int-B');
        expect(out.calendarSyncConfigId).toBe('cfg-B');
    });

    it('preserves _id and calendarEventId — overwriting them would desync the post-pull reconcile', () => {
        const override: PendingReassignOverride = { toUserId: 'user-B', targetIntegrationId: 'int-B', targetSyncConfigId: 'cfg-B' };
        const out = applyOverrideToItem(ITEM, override);
        expect(out._id).toBe('item-1');
        expect(out.calendarEventId).toBe('gcal-evt-1');
    });

    it('leaves calendar fields untouched when the override is account-only (non-calendar item path)', () => {
        const override: PendingReassignOverride = { toUserId: 'user-B' };
        const out = applyOverrideToItem(ITEM, override);
        expect(out.calendarIntegrationId).toBe('int-A');
        expect(out.calendarSyncConfigId).toBe('cfg-A');
    });

    it('returns a fresh object (no mutation of the source row)', () => {
        const override: PendingReassignOverride = { toUserId: 'user-B' };
        const out = applyOverrideToItem(ITEM, override);
        expect(out).not.toBe(ITEM);
        expect(ITEM.userId).toBe('user-A');
    });

    it('does not introduce calendar fields on a non-calendar item when the override is account-only', () => {
        // Reassigning a nextAction or inbox item across accounts must not invent calendar refs —
        // those would persist into the rendered row and confuse calendar-filter views that see
        // `calendarIntegrationId` as the "is this on a calendar" predicate.
        const nextAction: StoredItem = {
            _id: 'item-2',
            userId: 'user-A',
            status: 'nextAction',
            title: 'Call dentist',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
        };
        const out = applyOverrideToItem(nextAction, { toUserId: 'user-B' });
        expect(out.userId).toBe('user-B');
        expect(out.calendarIntegrationId).toBeUndefined();
        expect(out.calendarSyncConfigId).toBeUndefined();
    });
});

describe('applyOverrideToRoutine', () => {
    it('rewrites userId on the routine', () => {
        expect(applyOverrideToRoutine(ROUTINE, { toUserId: 'user-B' }).userId).toBe('user-B');
    });

    it('rewrites calendar config refs when provided so routine list views show the new account', () => {
        const out = applyOverrideToRoutine(ROUTINE, { toUserId: 'user-B', targetIntegrationId: 'int-B', targetSyncConfigId: 'cfg-B' });
        expect(out.calendarIntegrationId).toBe('int-B');
        expect(out.calendarSyncConfigId).toBe('cfg-B');
    });

    it('preserves identity fields (_id, calendarEventId) — overwriting calendarEventId would orphan the GCal master', () => {
        const out = applyOverrideToRoutine(ROUTINE, { toUserId: 'user-B', targetIntegrationId: 'int-B', targetSyncConfigId: 'cfg-B' });
        expect(out._id).toBe('r-1');
        expect(out.calendarEventId).toBe('gcal-master-1');
    });
});
