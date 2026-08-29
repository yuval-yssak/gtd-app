/** Regression test for the bug where changing a calendar item to an active non-calendar status
 * (nextAction / somedayMaybe / waitingFor / inbox) left its Google Calendar event orphaned. The
 * status→field matrix strips `calendarEventId` off the update snapshot before pushback runs, so
 * the fix hydrates the pre-update row onto `op.detachedCalendar` in the apply pipeline and routes
 * such ops through `removeItemGCalPresence` (delete the event / cancel the routine occurrence). */
/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts result before using ! */
import dayjs from 'dayjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { applyAndPublishOperation, applyAndPublishOperations } from '../lib/applyOperation.js';
import * as calendarPushback from '../lib/calendarPushback.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import type { CalendarIntegrationInterface, CalendarSyncConfigInterface, ItemInterface, ItemStatus, RoutineInterface } from '../types/entities.js';

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

const userId = 'user-calendar-detach-gcal';
const integrationId = 'integ-detach-1';
const configId = 'config-detach-1';

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
        title: 'Return the signal booster',
        timeStart: '2026-05-20T12:00:00Z',
        timeEnd: '2026-05-20T13:00:00Z',
        calendarEventId: 'gcal-evt-detach',
        calendarIntegrationId: integrationId,
        calendarSyncConfigId: configId,
        createdTs: '2026-05-10T00:00:00Z',
        updatedTs: '2026-05-10T00:00:00Z',
        ...overrides,
    };
}

/** Update snapshot for the same item re-clarified to a non-calendar status (linkage stripped, like real clients do). */
function detachedSnapshot(status: ItemStatus, overrides: Partial<ItemInterface> = {}): ItemInterface {
    return {
        _id: 'item-cal-1',
        user: userId,
        status,
        title: 'Return the signal booster',
        createdTs: '2026-05-10T00:00:00Z',
        updatedTs: '2026-05-11T00:00:00Z',
        ...overrides,
    };
}

describe('calendar → active-status transition cascades to GCal event removal', () => {
    it.each([
        'nextAction',
        'somedayMaybe',
        'waitingFor',
        'inbox',
    ] as const)('hydrates detachedCalendar and deletes the GCal event on calendar → %s', async (status) => {
        await seedCalendarIntegration();
        await itemsDAO.insertOne(calendarItem());
        const deleteEvent = vi.fn().mockResolvedValue(undefined);
        const buildProvider = () => fakeProviderWithDelete(deleteEvent);

        const op = await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'update', entityId: 'item-cal-1', snapshot: detachedSnapshot(status) },
            { deviceId: 'api:tok-1' },
        );

        expect(op.detachedCalendar).toMatchObject({ _id: 'item-cal-1', status: 'calendar', calendarEventId: 'gcal-evt-detach' });
        await calendarPushback.maybePushToGCal(op, buildProvider);
        expect(deleteEvent).toHaveBeenCalledWith('cal-1', 'gcal-evt-detach');

        // The item row itself was still updated to the new status.
        const row = await itemsDAO.findByOwnerAndId('item-cal-1', userId);
        expect(row?.status).toBe(status);
    });

    it('does NOT delete the GCal event on calendar → done (done keeps the event with a ✓ marker)', async () => {
        await seedCalendarIntegration();
        await itemsDAO.insertOne(calendarItem());
        const deleteEvent = vi.fn();
        // `done` keeps the calendar linkage on the snapshot, so pushback takes the existing-item
        // path and PATCHes the ✓ marker via updateEvent — the fake must provide it.
        const updateEvent = vi.fn().mockResolvedValue(undefined);
        const buildProvider = () => ({ deleteEvent, updateEvent, getCalendarTimeZone: vi.fn().mockResolvedValue('UTC') }) as never;

        const op = await applyAndPublishOperation(
            userId,
            {
                entityType: 'item',
                opType: 'update',
                entityId: 'item-cal-1',
                // `done` is archival — clients keep the calendar linkage on the snapshot.
                snapshot: calendarItem({ status: 'done', updatedTs: '2026-05-11T00:00:00Z' }),
            },
            { deviceId: 'api:tok-1' },
        );

        expect(op.detachedCalendar).toBeUndefined();
        await calendarPushback.maybePushToGCal(op, buildProvider);
        expect(deleteEvent).not.toHaveBeenCalled();
        expect(updateEvent).toHaveBeenCalled();
    });

    it('cancels the single GCal occurrence when a routine-generated instance leaves calendar status', async () => {
        await seedCalendarIntegration();
        const routine: RoutineInterface = {
            _id: 'routine-detach-1',
            user: userId,
            title: 'Weekly review',
            routineType: 'calendar',
            rrule: 'FREQ=WEEKLY',
            template: {},
            active: true,
            createdTs: '2026-05-01T00:00:00Z',
            updatedTs: '2026-05-01T00:00:00Z',
            calendarEventId: 'gcal-master-detach',
            calendarIntegrationId: integrationId,
            calendarSyncConfigId: configId,
        } as RoutineInterface;
        await routinesDAO.insertOne(routine);
        const instance: ItemInterface = calendarItem({
            _id: 'item-inst-1',
            calendarEventId: undefined,
            calendarIntegrationId: undefined,
            calendarSyncConfigId: undefined,
            routineId: 'routine-detach-1',
        });
        await itemsDAO.insertOne(instance);
        const cancelInstance = vi.fn().mockResolvedValue(undefined);

        const op = await applyAndPublishOperation(
            userId,
            {
                entityType: 'item',
                opType: 'update',
                entityId: 'item-inst-1',
                snapshot: detachedSnapshot('nextAction', { _id: 'item-inst-1', routineId: 'routine-detach-1' }),
            },
            { deviceId: 'api:tok-1' },
        );

        expect(op.detachedCalendar).toMatchObject({ _id: 'item-inst-1', routineId: 'routine-detach-1' });
        await calendarPushback.maybePushToGCal(op, () => fakeProviderWithCancelInstance(cancelInstance));
        expect(cancelInstance).toHaveBeenCalled();
        const firstCall = cancelInstance.mock.calls[0]!;
        expect(firstCall).toContain('gcal-master-detach');
    });

    it('skips the detach when the update loses last-write-wins (a newer calendar state stays in place)', async () => {
        await seedCalendarIntegration();
        await itemsDAO.insertOne(calendarItem({ updatedTs: '2026-05-12T00:00:00Z' }));
        const deleteEvent = vi.fn();

        const op = await applyAndPublishOperation(
            userId,
            // Stale op: updatedTs is older than the stored row's, so applyEntityOp won't replace it.
            { entityType: 'item', opType: 'update', entityId: 'item-cal-1', snapshot: detachedSnapshot('nextAction', { updatedTs: '2026-05-11T00:00:00Z' }) },
            { deviceId: 'api:tok-1' },
        );

        expect(op.detachedCalendar).toBeUndefined();
        await calendarPushback.maybePushToGCal(op, () => fakeProviderWithDelete(deleteEvent));
        expect(deleteEvent).not.toHaveBeenCalled();
        const row = await itemsDAO.findByOwnerAndId('item-cal-1', userId);
        expect(row?.status).toBe('calendar');
    });

    it('no-ops when the existing row is not a calendar item (nextAction → somedayMaybe)', async () => {
        await itemsDAO.insertOne(calendarItem({ status: 'nextAction', calendarEventId: undefined, timeStart: undefined, timeEnd: undefined }));
        const deleteEvent = vi.fn();

        const op = await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'update', entityId: 'item-cal-1', snapshot: detachedSnapshot('somedayMaybe') },
            { deviceId: 'api:tok-1' },
        );

        expect(op.detachedCalendar).toBeUndefined();
        await calendarPushback.maybePushToGCal(op, () => fakeProviderWithDelete(deleteEvent));
        expect(deleteEvent).not.toHaveBeenCalled();
    });

    it('skips GCal removal for fromGmail events (read-only via Calendar API)', async () => {
        await seedCalendarIntegration();
        await itemsDAO.insertOne(calendarItem({ eventType: 'fromGmail' }));
        const deleteEvent = vi.fn();

        const op = await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'update', entityId: 'item-cal-1', snapshot: detachedSnapshot('nextAction') },
            { deviceId: 'api:tok-1' },
        );

        // The sidecar is still hydrated (the item genuinely leaves calendar status)…
        expect(op.detachedCalendar).toMatchObject({ eventType: 'fromGmail' });
        // …but pushback must not touch the read-only event.
        await calendarPushback.maybePushToGCal(op, () => fakeProviderWithDelete(deleteEvent));
        expect(deleteEvent).not.toHaveBeenCalled();
    });

    it('does not cancel an occurrence when the routine is disconnect-kept (lastKnownCalendarEventId, no live link)', async () => {
        await seedCalendarIntegration();
        const routine: RoutineInterface = {
            _id: 'routine-kept-1',
            user: userId,
            title: 'Kept routine',
            routineType: 'calendar',
            rrule: 'FREQ=WEEKLY',
            template: {},
            active: true,
            createdTs: '2026-05-01T00:00:00Z',
            updatedTs: '2026-05-01T00:00:00Z',
            // Disconnect-with-keep renamed calendarEventId → lastKnownCalendarEventId.
            lastKnownCalendarEventId: 'gcal-master-kept',
        } as RoutineInterface;
        await routinesDAO.insertOne(routine);
        await itemsDAO.insertOne(
            calendarItem({
                _id: 'item-kept-inst-1',
                calendarEventId: undefined,
                calendarIntegrationId: undefined,
                calendarSyncConfigId: undefined,
                routineId: 'routine-kept-1',
            }),
        );
        const cancelInstance = vi.fn();

        const op = await applyAndPublishOperation(
            userId,
            {
                entityType: 'item',
                opType: 'update',
                entityId: 'item-kept-inst-1',
                snapshot: detachedSnapshot('nextAction', { _id: 'item-kept-inst-1', routineId: 'routine-kept-1' }),
            },
            { deviceId: 'api:tok-1' },
        );

        await calendarPushback.maybePushToGCal(op, () => fakeProviderWithCancelInstance(cancelInstance));
        expect(cancelInstance).not.toHaveBeenCalled();
    });

    it('does not hydrate detachedCalendar for a disconnect-kept standalone item (linkage already renamed away)', async () => {
        await itemsDAO.insertOne(
            calendarItem({
                calendarEventId: undefined,
                calendarIntegrationId: undefined,
                calendarSyncConfigId: undefined,
                lastKnownCalendarEventId: 'gcal-evt-kept',
            }),
        );

        const op = await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'update', entityId: 'item-cal-1', snapshot: detachedSnapshot('nextAction') },
            { deviceId: 'api:tok-1' },
        );

        expect(op.detachedCalendar).toBeUndefined();
    });

    it('hydrates detachedCalendar through the batch pipeline (/sync/push path)', async () => {
        await seedCalendarIntegration();
        await itemsDAO.insertOne(calendarItem());
        const deleteEvent = vi.fn().mockResolvedValue(undefined);

        const { ops } = await applyAndPublishOperations(
            userId,
            [{ entityType: 'item', opType: 'update', entityId: 'item-cal-1', snapshot: detachedSnapshot('nextAction') }],
            { deviceId: 'device-abc' },
        );

        expect(ops).toHaveLength(1);
        const [op] = ops;
        if (!op) throw new Error('expected one op');
        expect(op.detachedCalendar).toMatchObject({ calendarEventId: 'gcal-evt-detach' });
        await calendarPushback.maybePushToGCal(op, () => fakeProviderWithDelete(deleteEvent));
        expect(deleteEvent).toHaveBeenCalledWith('cal-1', 'gcal-evt-detach');
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
