/** Regression test for the bug where deleting a calendar-linked item via gtd_batch (snapshot:null)
 * skipped GCal pushback. The fix hydrates the snapshot in `applyAndPublishOperation` and routes
 * item-delete ops through a dedicated `handleItemDelete` branch that calls `provider.deleteEvent`. */
/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts result before using ! */
import dayjs from 'dayjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { applyAndPublishOperation } from '../lib/applyOperation.js';
import * as calendarPushback from '../lib/calendarPushback.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import type { CalendarIntegrationInterface, CalendarSyncConfigInterface, ItemInterface, RoutineInterface } from '../types/entities.js';

beforeAll(async () => {
    await loadDataAccess('gtd_test');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([
        db.collection('items').deleteMany({}),
        db.collection('routines').deleteMany({}),
        db.collection('operations').deleteMany({}),
        db.collection('calendarIntegrations').deleteMany({}),
        db.collection('calendarSyncConfigs').deleteMany({}),
    ]);
    vi.restoreAllMocks();
});

const userId = 'user-item-delete-gcal';
const integrationId = 'integ-1';
const configId = 'config-1';

async function seedCalendarIntegration() {
    const now = dayjs().toISOString();
    const integration: CalendarIntegrationInterface = {
        _id: integrationId,
        user: userId,
        provider: 'google',
        accessToken: 'at',
        refreshToken: 'rt',
        tokenExpiry: now,
        createdTs: now,
        updatedTs: now,
    };
    const config: CalendarSyncConfigInterface = {
        _id: configId,
        user: userId,
        integrationId,
        calendarId: 'cal-1',
        isDefault: true,
        enabled: true,
        timeZone: 'UTC',
        createdTs: now,
        updatedTs: now,
    };
    await calendarIntegrationsDAO.insertEncrypted(integration);
    await calendarSyncConfigsDAO.insertOne(config);
}

function calendarItem(overrides: Partial<ItemInterface> = {}): ItemInterface {
    return {
        _id: 'item-cal-1',
        user: userId,
        status: 'calendar',
        title: 'Lunch with Alex',
        timeStart: '2026-05-20T12:00:00Z',
        timeEnd: '2026-05-20T13:00:00Z',
        calendarEventId: 'gcal-evt-abc',
        calendarIntegrationId: integrationId,
        calendarSyncConfigId: configId,
        createdTs: '2026-05-10T00:00:00Z',
        updatedTs: '2026-05-10T00:00:00Z',
        ...overrides,
    };
}

describe('item-delete cascades to GCal via maybePushToGCal', () => {
    it('hydrates snapshot:null delete ops with the pre-delete row before pushback runs', async () => {
        await seedCalendarIntegration();
        await itemsDAO.insertOne(calendarItem());
        const pushSpy = vi.spyOn(calendarPushback, 'maybePushToGCal').mockResolvedValue(undefined);

        const op = await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'delete', entityId: 'item-cal-1', snapshot: null },
            { deviceId: 'api:tok-1' },
        );

        expect(op.snapshot).toMatchObject({ _id: 'item-cal-1', calendarEventId: 'gcal-evt-abc' });
        // notify fan-out is fire-and-forget under the hood — poll briefly for the pushback call.
        await waitFor(() => pushSpy.mock.calls.length >= 1);
        const [arg] = pushSpy.mock.calls[0]!;
        expect(arg.opType).toBe('delete');
        expect(arg.entityType).toBe('item');
        expect(arg.snapshot).toMatchObject({ calendarEventId: 'gcal-evt-abc' });
    });

    it('routes item-delete through the dedicated handler that calls provider.deleteEvent', async () => {
        await seedCalendarIntegration();
        await itemsDAO.insertOne(calendarItem());
        const deleteEvent = vi.fn().mockResolvedValue(undefined);
        const buildProvider = () => fakeProviderWithDelete(deleteEvent);

        const op = await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'delete', entityId: 'item-cal-1', snapshot: null },
            { deviceId: 'api:tok-1' },
        );

        await calendarPushback.maybePushToGCal(op, buildProvider);
        expect(deleteEvent).toHaveBeenCalledWith('cal-1', 'gcal-evt-abc');
    });

    it('cancels a single GCal occurrence when the deleted item is a routine instance', async () => {
        await seedCalendarIntegration();
        const routine: RoutineInterface = {
            _id: 'routine-1',
            user: userId,
            title: 'Weekly review',
            routineType: 'calendar',
            rrule: 'FREQ=WEEKLY',
            template: {},
            active: true,
            createdTs: '2026-05-01T00:00:00Z',
            updatedTs: '2026-05-01T00:00:00Z',
            calendarEventId: 'gcal-master-1',
            calendarIntegrationId: integrationId,
            calendarSyncConfigId: configId,
        } as RoutineInterface;
        await routinesDAO.insertOne(routine);
        const instance: ItemInterface = {
            _id: 'item-inst-1',
            user: userId,
            status: 'calendar',
            title: 'Weekly review',
            routineId: 'routine-1',
            timeStart: '2026-05-22T10:00:00Z',
            timeEnd: '2026-05-22T11:00:00Z',
            createdTs: '2026-05-15T00:00:00Z',
            updatedTs: '2026-05-15T00:00:00Z',
        };
        await itemsDAO.insertOne(instance);
        const cancelInstance = vi.fn().mockResolvedValue(undefined);
        const buildProvider = () => fakeProviderWithCancelInstance(cancelInstance);

        const op = await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'delete', entityId: 'item-inst-1', snapshot: null },
            { deviceId: 'api:tok-1' },
        );

        await calendarPushback.maybePushToGCal(op, buildProvider);
        // pushRoutineInstanceCancellation passes the master eventId in its call to the provider.
        expect(cancelInstance).toHaveBeenCalled();
        const firstCall = cancelInstance.mock.calls[0]!;
        expect(firstCall).toContain('gcal-master-1');
    });

    it('skips instance cancellation for occurrences beyond the routine UNTIL cap, still cancels at the cap', async () => {
        // Capping a routine's rrule rewrites the GCal master with UNTIL, which removes every
        // occurrence past the cap — a cancellation PATCH for such an instance gets a permanent
        // 400 from Google. The regen that trims beyond-cap items must therefore not push
        // per-instance cancellations for them.
        await seedCalendarIntegration();
        const routine: RoutineInterface = {
            _id: 'routine-capped',
            user: userId,
            title: 'Daily check',
            routineType: 'calendar',
            rrule: 'FREQ=DAILY;UNTIL=20260901T235959Z',
            template: {},
            active: true,
            createdTs: '2026-08-01T00:00:00Z',
            updatedTs: '2026-08-01T00:00:00Z',
            calendarEventId: 'gcal-master-capped',
            calendarIntegrationId: integrationId,
            calendarSyncConfigId: configId,
        } as RoutineInterface;
        await routinesDAO.insertOne(routine);
        const beyondCap: ItemInterface = {
            _id: 'item-beyond-cap',
            user: userId,
            status: 'calendar',
            title: 'Daily check',
            routineId: 'routine-capped',
            timeStart: '2026-09-08T15:00:00',
            timeEnd: '2026-09-08T15:10:00',
            createdTs: '2026-08-01T00:00:00Z',
            updatedTs: '2026-08-01T00:00:00Z',
        };
        const atCap: ItemInterface = { ...beyondCap, _id: 'item-at-cap', timeStart: '2026-09-01T15:00:00', timeEnd: '2026-09-01T15:10:00' };
        await itemsDAO.insertOne(beyondCap);
        await itemsDAO.insertOne(atCap);
        const cancelInstance = vi.fn().mockResolvedValue(undefined);
        const buildProvider = () => fakeProviderWithCancelInstance(cancelInstance);

        const beyondOp = await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'delete', entityId: 'item-beyond-cap', snapshot: null },
            { deviceId: 'api:tok-1' },
        );
        await calendarPushback.maybePushToGCal(beyondOp, buildProvider);
        expect(cancelInstance).not.toHaveBeenCalled();

        // Boundary: an occurrence ON the UNTIL day still exists on the master — it must cancel.
        const atCapOp = await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'delete', entityId: 'item-at-cap', snapshot: null },
            { deviceId: 'api:tok-1' },
        );
        await calendarPushback.maybePushToGCal(atCapOp, buildProvider);
        expect(cancelInstance).toHaveBeenCalledTimes(1);
    });

    it('still cancels a far-future occurrence when the routine rrule carries no UNTIL', async () => {
        // Pins the guard's null branch: an uncapped rrule must never trigger the skip, however
        // far out the occurrence is — only an explicit UNTIL proves the master dropped it.
        await seedCalendarIntegration();
        const routine: RoutineInterface = {
            _id: 'routine-uncapped',
            user: userId,
            title: 'Daily check',
            routineType: 'calendar',
            rrule: 'FREQ=DAILY',
            template: {},
            active: true,
            createdTs: '2026-08-01T00:00:00Z',
            updatedTs: '2026-08-01T00:00:00Z',
            calendarEventId: 'gcal-master-uncapped',
            calendarIntegrationId: integrationId,
            calendarSyncConfigId: configId,
        } as RoutineInterface;
        await routinesDAO.insertOne(routine);
        const farFuture: ItemInterface = {
            _id: 'item-far-future',
            user: userId,
            status: 'calendar',
            title: 'Daily check',
            routineId: 'routine-uncapped',
            timeStart: '2027-06-08T15:00:00',
            timeEnd: '2027-06-08T15:10:00',
            createdTs: '2026-08-01T00:00:00Z',
            updatedTs: '2026-08-01T00:00:00Z',
        };
        await itemsDAO.insertOne(farFuture);
        const cancelInstance = vi.fn().mockResolvedValue(undefined);
        const buildProvider = () => fakeProviderWithCancelInstance(cancelInstance);

        const op = await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'delete', entityId: 'item-far-future', snapshot: null },
            { deviceId: 'api:tok-1' },
        );
        await calendarPushback.maybePushToGCal(op, buildProvider);
        expect(cancelInstance).toHaveBeenCalledTimes(1);
    });

    it('judges the UNTIL cap by the exception original date, not the moved timeStart', async () => {
        // A moved instance carries its rrule truth on the routine's `modified` exception — its
        // `timeStart` is the NEW date. An item moved beyond the cap whose original occurrence sits
        // AT the cap still exists on the master, so its deletion must cancel, not skip.
        await seedCalendarIntegration();
        const routine: RoutineInterface = {
            _id: 'routine-capped-moved',
            user: userId,
            title: 'Daily check',
            routineType: 'calendar',
            rrule: 'FREQ=DAILY;UNTIL=20260901T235959Z',
            template: {},
            active: true,
            createdTs: '2026-08-01T00:00:00Z',
            updatedTs: '2026-08-01T00:00:00Z',
            calendarEventId: 'gcal-master-capped-moved',
            calendarIntegrationId: integrationId,
            calendarSyncConfigId: configId,
            routineExceptions: [{ date: '2026-09-01', type: 'modified', itemId: 'item-moved', newTimeStart: '2026-09-08T15:00:00' }],
        } as RoutineInterface;
        await routinesDAO.insertOne(routine);
        const moved: ItemInterface = {
            _id: 'item-moved',
            user: userId,
            status: 'calendar',
            title: 'Daily check',
            routineId: 'routine-capped-moved',
            timeStart: '2026-09-08T15:00:00',
            timeEnd: '2026-09-08T15:10:00',
            createdTs: '2026-08-01T00:00:00Z',
            updatedTs: '2026-08-01T00:00:00Z',
        };
        await itemsDAO.insertOne(moved);
        const cancelInstance = vi.fn().mockResolvedValue(undefined);
        const buildProvider = () => fakeProviderWithCancelInstance(cancelInstance);

        const op = await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'delete', entityId: 'item-moved', snapshot: null },
            { deviceId: 'api:tok-1' },
        );
        await calendarPushback.maybePushToGCal(op, buildProvider);
        expect(cancelInstance).toHaveBeenCalledTimes(1);
        // The provider receives the rrule original date, not the moved-to date.
        const [call] = cancelInstance.mock.calls;
        if (!call) throw new Error('expected one cancelRecurringInstance call');
        expect(call).toContain('2026-09-01');
    });

    it('no-ops when the item had no calendar linkage (inbox-only delete)', async () => {
        const inbox: ItemInterface = {
            _id: 'item-inbox-1',
            user: userId,
            status: 'inbox',
            title: 'just a thought',
            createdTs: '2026-05-10T00:00:00Z',
            updatedTs: '2026-05-10T00:00:00Z',
        };
        await itemsDAO.insertOne(inbox);
        const deleteEvent = vi.fn();
        const buildProvider = () => fakeProviderWithDelete(deleteEvent);

        const op = await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'delete', entityId: 'item-inbox-1', snapshot: null },
            { deviceId: 'api:tok-1' },
        );
        await calendarPushback.maybePushToGCal(op, buildProvider);
        expect(deleteEvent).not.toHaveBeenCalled();
    });

    it('no-ops when the row was already gone (concurrent delete from another device)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const deleteEvent = vi.fn();
        const buildProvider = () => fakeProviderWithDelete(deleteEvent);

        const op = await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'delete', entityId: 'item-already-gone', snapshot: null },
            { deviceId: 'api:tok-1' },
        );
        expect(op.snapshot).toBeNull();
        expect(warn).toHaveBeenCalled();
        await calendarPushback.maybePushToGCal(op, buildProvider);
        expect(deleteEvent).not.toHaveBeenCalled();
    });
});

// The CalendarProvider interface has many methods; we only need one or two per test. Return a
// proxy that satisfies the type via cast — call sites assert on the spies' invocation, not on
// type-level completeness.
function fakeProviderWithDelete(deleteEvent: ReturnType<typeof vi.fn>) {
    return { deleteEvent, getCalendarTimeZone: vi.fn().mockResolvedValue('UTC') } as never;
}
function fakeProviderWithCancelInstance(cancel: ReturnType<typeof vi.fn>) {
    return { cancelRecurringInstance: cancel, getCalendarTimeZone: vi.fn().mockResolvedValue('UTC') } as never;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('waitFor: predicate never became true');
}
