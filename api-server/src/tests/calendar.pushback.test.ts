/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts status before using ! */
import dayjs from 'dayjs';
import { describe, expect, it, vi } from 'vitest';
import { GoogleCalendarProvider } from '../calendarProviders/GoogleCalendarProvider.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { gcalCreationInFlight, maybePushToGCal } from '../lib/calendarPushback.js';
import type { ItemInterface, OperationInterface, RoutineInterface } from '../types/entities.js';
import {
    app,
    getInsertRequestBody,
    getPatchRequestBody,
    getUserId,
    insertIntegrationWithConfig,
    loginAsAlice,
    makeItem,
    makeOp,
    makeRoutine,
    mockBuildProvider,
    spyOnGCalEventsApi,
    useCalendarTestLifecycle,
} from './calendarTestKit.js';
import { authenticatedRequest, oauthLogin } from './helpers.js';

useCalendarTestLifecycle();

describe('calendar push-back — existing items', () => {
    it('deletes GCal event when item is trashed', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            calendarEventId: 'gcal-ev-1',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            status: 'trash',
        });
        await itemsDAO.insertOne(item);

        const deleteSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'deleteEvent').mockResolvedValue(undefined);
        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(deleteSpy).toHaveBeenCalledWith('primary', 'gcal-ev-1');
        // Trash branch must not also fall through to updateEvent — splitting the prior trash||done
        // branch must keep these mutually exclusive.
        expect(updateSpy).not.toHaveBeenCalled();
        // Verify lastPushedToGCalTs was stamped.
        const updated = await itemsDAO.findByOwnerAndId(item._id!, userId);
        expect(updated!.lastPushedToGCalTs).toBeTruthy();
    });

    it('updates GCal event when item title/time changes', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            calendarEventId: 'gcal-ev-2',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            title: 'Updated Meeting',
        });
        await itemsDAO.insertOne(item);

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(updateSpy).toHaveBeenCalledOnce();
        expect(updateSpy.mock.calls[0]![1]).toBe('gcal-ev-2');
    });

    it('marks GCal event with "✓ " prefix and sage colorId when item is done (does not delete)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            calendarEventId: 'gcal-ev-done',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            title: 'Verify done sync',
            status: 'done',
        });
        await itemsDAO.insertOne(item);

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue(undefined);
        const deleteSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'deleteEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(deleteSpy).not.toHaveBeenCalled();
        expect(updateSpy).toHaveBeenCalledOnce();
        const [calendarId, eventId, updates] = updateSpy.mock.calls[0]!;
        expect(calendarId).toBe('primary');
        expect(eventId).toBe('gcal-ev-done');
        expect(updates).toMatchObject({ title: '✓ Verify done sync', colorId: '2' });

        const updated = await itemsDAO.findByOwnerAndId(item._id!, userId);
        // Stored title stays clean — marker lives only in GCal.
        expect(updated!.title).toBe('Verify done sync');
        expect(updated!.lastPushedToGCalTs).toBeTruthy();
    });

    it('clears done marker (clean title + colorId: null) when item is reopened to calendar', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            calendarEventId: 'gcal-ev-reopen',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            title: 'Verify done sync',
            status: 'calendar',
        });
        await itemsDAO.insertOne(item);

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(updateSpy).toHaveBeenCalledOnce();
        const updates = updateSpy.mock.calls[0]![2];
        expect(updates).toMatchObject({ title: 'Verify done sync', colorId: null });
    });
});

describe('calendar push-back — new items', () => {
    it('creates GCal event for app-created calendar item', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId);
        await itemsDAO.insertOne(item);

        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockResolvedValue({ eventId: 'new-gcal-id' });

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(createSpy).toHaveBeenCalledOnce();
        // Verify the item was linked to the new GCal event.
        const updated = await itemsDAO.findByOwnerAndId(item._id!, userId);
        expect(updated!.calendarEventId).toBe('new-gcal-id');
        expect(updated!.calendarIntegrationId).toBe('int-1');
        expect(updated!.calendarSyncConfigId).toBe('sync-config-1');
    });

    it('skips items without timeStart/timeEnd', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, { timeStart: undefined, timeEnd: undefined });

        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockResolvedValue({ eventId: 'new-id' });

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(createSpy).not.toHaveBeenCalled();
    });

    it('skips item creation when DB already has calendarEventId (concurrent push-back guard)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Snapshot passed in the op lacks calendarEventId (captured at queue-time).
        const snapshotWithoutLink = makeItem(userId);

        // But the DB record already has it — a concurrent push-back linked it first.
        const itemInDb = makeItem(userId, {
            calendarEventId: 'already-linked',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
        });
        await itemsDAO.insertOne(itemInDb);

        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockResolvedValue({ eventId: 'duplicate-id' });

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: snapshotWithoutLink._id!, snapshot: snapshotWithoutLink }), mockBuildProvider());

        expect(createSpy).not.toHaveBeenCalled();
    });

    it('does not use the single-event create path for routine-managed calendar items', async () => {
        // Routine-managed items don't get their own GCal event — they're represented by the routine's
        // master recurring event, with per-instance overrides when edited.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, { routineId: 'routine-1' });

        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockResolvedValue({ eventId: 'new-id' });
        // Without a routine in the DB, pushRoutineInstanceOverride also no-ops — so neither
        // path touches GCal. Both are exclusive: createEvent is not called, and the override
        // path exits early because the routine can't be resolved.

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(createSpy).not.toHaveBeenCalled();
    });
});

describe('calendar push-back — routine instance overrides', () => {
    async function setupRoutineWithEvent(userId: string, routineOverrides: Partial<RoutineInterface> = {}) {
        const routine = makeRoutine(userId, {
            calendarEventId: 'recurring-master-1',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            ...routineOverrides,
        });
        await routinesDAO.insertOne(routine);
        return routine;
    }

    it('pushes a single-instance override when a routine-generated item is edited', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await setupRoutineWithEvent(userId);

        const item = makeItem(userId, {
            _id: 'item-inst-1',
            routineId: 'routine-1',
            title: 'Moved standup',
            timeStart: '2026-05-04T11:00:00.000Z',
            timeEnd: '2026-05-04T11:30:00.000Z',
        });
        await itemsDAO.insertOne(item);

        const spy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(spy).toHaveBeenCalledOnce();
        expect(spy.mock.calls[0]![0]).toBe('recurring-master-1');
        expect(spy.mock.calls[0]![1]).toBe('2026-05-04'); // originalDate derived from timeStart
        expect(spy.mock.calls[0]![2]).toMatchObject({ title: 'Moved standup', timeStart: '2026-05-04T11:00:00.000Z', timeEnd: '2026-05-04T11:30:00.000Z' });
        expect(spy.mock.calls[0]![3]).toBe('primary'); // calendarId
        expect(spy.mock.calls[0]![4]).toBe('Asia/Jerusalem'); // timeZone

        const updated = await itemsDAO.findByOwnerAndId(item._id!, userId);
        expect(updated!.lastPushedToGCalTs).toBeTruthy();
    });

    it('uses the routine exception date as originalDate when the item was previously moved', async () => {
        // Regression: on a subsequent edit, snapshot.timeStart is the MOVED date. The rrule
        // occurrence date lives only on the routine's `modified` exception. Look it up.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await setupRoutineWithEvent(userId, {
            routineExceptions: [
                {
                    date: '2026-05-04', // original rrule date
                    type: 'modified' as const,
                    itemId: 'item-inst-2',
                    newTimeStart: '2026-05-05T09:00:00.000Z',
                    newTimeEnd: '2026-05-05T09:30:00.000Z',
                },
            ],
        });

        const item = makeItem(userId, {
            _id: 'item-inst-2',
            routineId: 'routine-1',
            title: 'Re-edited',
            // This is the MOVED date from the prior edit — NOT the original rrule date.
            timeStart: '2026-05-05T09:00:00.000Z',
            timeEnd: '2026-05-05T09:30:00.000Z',
        });
        await itemsDAO.insertOne(item);

        const spy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(spy).toHaveBeenCalledOnce();
        expect(spy.mock.calls[0]![1]).toBe('2026-05-04'); // original rrule date recovered from exception
    });

    it('no-ops when the routine is not linked to a GCal recurring event', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // Routine exists but has no calendarEventId — can't push an override.
        const unlinkedRoutine = makeRoutine(userId, { _id: 'routine-unlinked' });
        await routinesDAO.insertOne(unlinkedRoutine);

        const item = makeItem(userId, {
            _id: 'item-no-link',
            routineId: 'routine-unlinked',
        });
        await itemsDAO.insertOne(item);

        const spy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(spy).not.toHaveBeenCalled();
    });

    it('no-ops when the routine cannot be found (orphaned routineId)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // No routine inserted.

        const item = makeItem(userId, {
            _id: 'item-orphan',
            routineId: 'routine-missing',
        });
        await itemsDAO.insertOne(item);

        const spy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(spy).not.toHaveBeenCalled();
    });

    it('no-ops when the snapshot has no timeStart', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await setupRoutineWithEvent(userId);

        // Items without timeStart can't have a rrule date — skip gracefully.
        const item = makeItem(userId, { _id: 'item-no-ts', routineId: 'routine-1', timeStart: undefined, timeEnd: undefined });

        const spy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(spy).not.toHaveBeenCalled();
    });

    it('cancels the GCal instance when a routine-generated item is trashed (skipped exception)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await setupRoutineWithEvent(userId);

        const item = makeItem(userId, {
            _id: 'item-trash-1',
            routineId: 'routine-1',
            status: 'trash',
            timeStart: '2026-04-27T09:00:00.000Z',
            timeEnd: '2026-04-27T10:00:00.000Z',
        });
        await itemsDAO.insertOne(item);

        const cancelSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'cancelRecurringInstance').mockResolvedValue(undefined);
        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(cancelSpy).toHaveBeenCalledOnce();
        // 4th arg is the instance-id option (undefined here — legacy item without calendarInstanceEventId).
        expect(cancelSpy).toHaveBeenCalledWith('recurring-master-1', '2026-04-27', 'primary', undefined);
        expect(updateSpy).not.toHaveBeenCalled();

        const updated = await itemsDAO.findByOwnerAndId(item._id!, userId);
        expect(updated!.lastPushedToGCalTs).toBeTruthy();
    });

    it('marks the GCal instance with ✓ prefix and sage colorId when a routine-generated item is done (does not cancel)', async () => {
        // Matrix A8: completion is GTD-local — the GCal occurrence must remain so other calendars
        // / attendees still see the event. Cancelling on done would also round-trip a `deleted`
        // exception back via GCal sync and flip the app-side item from `done` to `trash`. Instead,
        // a single-instance override applies the ✓ title prefix + sage colorId to that occurrence.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await setupRoutineWithEvent(userId);

        const item = makeItem(userId, {
            _id: 'item-done-1',
            routineId: 'routine-1',
            status: 'done',
            title: 'Standup',
            timeStart: '2026-04-27T09:00:00.000Z',
            timeEnd: '2026-04-27T10:00:00.000Z',
        });
        await itemsDAO.insertOne(item);

        const cancelSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'cancelRecurringInstance').mockResolvedValue(undefined);
        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(cancelSpy).not.toHaveBeenCalled();
        expect(updateSpy).toHaveBeenCalledOnce();
        expect(updateSpy.mock.calls[0]![0]).toBe('recurring-master-1');
        expect(updateSpy.mock.calls[0]![1]).toBe('2026-04-27');
        expect(updateSpy.mock.calls[0]![2]).toMatchObject({ title: '✓ Standup', colorId: '2' });

        const updated = await itemsDAO.findByOwnerAndId(item._id!, userId);
        // Stored title stays clean — marker lives only in GCal.
        expect(updated!.title).toBe('Standup');
        expect(updated!.lastPushedToGCalTs).toBeTruthy();
    });

    it('patches the known calendarInstanceEventId directly on done, without an events.instances lookup', async () => {
        // Regression: routine-generated `done` markers never reached GCal because the override path
        // re-resolved the instance via a date-window events.instances query, which silently misses
        // already-modified instances (the prod failure on item 9a19f9ab…). When the item carries
        // its `calendarInstanceEventId` — exactly what GCal returns as event.id for the instance —
        // we must patch that id directly and skip the lookup. Drives the REAL updateRecurringInstance
        // (only events.instances/patch are stubbed) so the resolution path is exercised, not mocked.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await setupRoutineWithEvent(userId);

        const item = makeItem(userId, {
            _id: 'item-done-cieid',
            routineId: 'routine-1',
            status: 'done',
            title: 'Standup',
            timeStart: '2026-04-27T09:00:00.000Z',
            timeEnd: '2026-04-27T10:00:00.000Z',
            calendarInstanceEventId: 'recurring-master-1_20260427T060000Z',
        });
        await itemsDAO.insertOne(item);

        const { patchSpy, instancesSpy } = spyOnGCalEventsApi();
        // Simulate the prod failure: the date-window lookup returns NO matching instance. With the fix
        // the patch must still land, because resolution comes from calendarInstanceEventId, not this call.
        instancesSpy.mockResolvedValue({ data: { items: [] } });

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(instancesSpy).not.toHaveBeenCalled();
        const params = getPatchRequestBody(patchSpy);
        expect((params as { eventId?: string }).eventId).toBe('recurring-master-1_20260427T060000Z');
        expect(params.requestBody).toMatchObject({ summary: '✓ Standup', colorId: '2' });
    });

    it('swallows a 404 (drifted instance id) as a skip rather than throwing', async () => {
        // A caller-supplied instanceEventId can drift from what GCal actually materialized (tz /
        // timeOfDay reconstruction). The patch then 404s — we want the same warn-and-skip as a missed
        // findInstanceId lookup, not a raw error bubbling up through the fire-and-forget pushback caller.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await setupRoutineWithEvent(userId);

        const item = makeItem(userId, {
            _id: 'item-done-404',
            routineId: 'routine-1',
            status: 'done',
            title: 'Standup',
            timeStart: '2026-04-27T09:00:00.000Z',
            timeEnd: '2026-04-27T10:00:00.000Z',
            calendarInstanceEventId: 'recurring-master-1_20260427T060000Z',
        });
        await itemsDAO.insertOne(item);

        const { patchSpy } = spyOnGCalEventsApi();
        const notFound = Object.assign(new Error('Not Found'), { code: 404 });
        patchSpy.mockRejectedValue(notFound);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        // maybePushToGCal must resolve (not reject) — the 404 is swallowed inside the provider.
        await expect(
            maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider()),
        ).resolves.toBeUndefined();
        expect(patchSpy).toHaveBeenCalledOnce();
        // Log parity: the drift case warns just like a missed findInstanceId lookup.
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no longer exists (404) — skipping'));
    });

    it('patches the known calendarInstanceEventId directly on trash (cancellation), without an events.instances lookup', async () => {
        // Symmetric to the done case: single-instance trash cancels via the known instance id when
        // present, so a previously-moved instance still cancels the correct occurrence.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await setupRoutineWithEvent(userId);

        const item = makeItem(userId, {
            _id: 'item-trash-cieid',
            routineId: 'routine-1',
            status: 'trash',
            timeStart: '2026-04-27T09:00:00.000Z',
            timeEnd: '2026-04-27T10:00:00.000Z',
            calendarInstanceEventId: 'recurring-master-1_20260427T060000Z',
        });
        await itemsDAO.insertOne(item);

        const { patchSpy, instancesSpy } = spyOnGCalEventsApi();
        instancesSpy.mockResolvedValue({ data: { items: [] } });

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(instancesSpy).not.toHaveBeenCalled();
        const params = getPatchRequestBody(patchSpy);
        expect((params as { eventId?: string }).eventId).toBe('recurring-master-1_20260427T060000Z');
        expect(params.requestBody).toMatchObject({ status: 'cancelled' });
    });

    it('falls back to the events.instances lookup when a legacy item has no calendarInstanceEventId', async () => {
        // Items generated before calendarInstanceEventId existed must still resolve via the date window.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await setupRoutineWithEvent(userId);

        const item = makeItem(userId, {
            _id: 'item-done-legacy',
            routineId: 'routine-1',
            status: 'done',
            title: 'Standup',
            timeStart: '2026-04-27T09:00:00.000Z',
            timeEnd: '2026-04-27T10:00:00.000Z',
            // no calendarInstanceEventId
        });
        await itemsDAO.insertOne(item);

        const { patchSpy, instancesSpy } = spyOnGCalEventsApi();
        instancesSpy.mockResolvedValue({
            data: { items: [{ id: 'resolved-by-date', originalStartTime: { dateTime: '2026-04-27T09:00:00.000Z' } }] },
        });

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(instancesSpy).toHaveBeenCalledOnce();
        const params = getPatchRequestBody(patchSpy);
        expect((params as { eventId?: string }).eventId).toBe('resolved-by-date');
    });

    it('clears the done marker on the GCal instance when a routine-generated item is reopened to calendar', async () => {
        // Reopen path: status flips back to 'calendar'. The single-instance override must send
        // the clean title and colorId: null so the instance reverts to the master's defaults.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await setupRoutineWithEvent(userId);

        const item = makeItem(userId, {
            _id: 'item-reopen-1',
            routineId: 'routine-1',
            status: 'calendar',
            title: 'Standup',
            timeStart: '2026-04-27T09:00:00.000Z',
            timeEnd: '2026-04-27T10:00:00.000Z',
        });
        await itemsDAO.insertOne(item);

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(updateSpy).toHaveBeenCalledOnce();
        expect(updateSpy.mock.calls[0]![2]).toMatchObject({ title: 'Standup', colorId: null });
    });

    it('uses the prior modified exception date when trashing a previously-moved instance', async () => {
        // Edit-then-trash: snapshot.timeStart is the MOVED date, but the rrule's originalDate
        // lives only on the routine's `modified` exception. The cancellation must target the
        // original rrule date, not the moved one.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await setupRoutineWithEvent(userId, {
            routineExceptions: [
                {
                    date: '2026-04-27', // original rrule date
                    type: 'modified' as const,
                    itemId: 'item-trash-moved',
                    newTimeStart: '2026-04-28T09:00:00.000Z',
                    newTimeEnd: '2026-04-28T10:00:00.000Z',
                },
            ],
        });

        const item = makeItem(userId, {
            _id: 'item-trash-moved',
            routineId: 'routine-1',
            status: 'trash',
            // Moved date — NOT the original rrule date.
            timeStart: '2026-04-28T09:00:00.000Z',
            timeEnd: '2026-04-28T10:00:00.000Z',
        });
        await itemsDAO.insertOne(item);

        const cancelSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'cancelRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(cancelSpy).toHaveBeenCalledOnce();
        expect(cancelSpy.mock.calls[0]![1]).toBe('2026-04-27'); // original rrule date, recovered from modified exception
    });

    it('no-ops cancellation when the routine is not linked to a GCal recurring event', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        const unlinkedRoutine = makeRoutine(userId, { _id: 'routine-unlinked-cancel' });
        await routinesDAO.insertOne(unlinkedRoutine);

        const item = makeItem(userId, {
            _id: 'item-trash-no-link',
            routineId: 'routine-unlinked-cancel',
            status: 'trash',
        });
        await itemsDAO.insertOne(item);

        const cancelSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'cancelRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(cancelSpy).not.toHaveBeenCalled();
    });

    it('no-ops cancellation when routineId is orphaned (routine missing from DB)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            _id: 'item-trash-orphan',
            routineId: 'routine-missing',
            status: 'trash',
        });
        await itemsDAO.insertOne(item);

        const cancelSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'cancelRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(cancelSpy).not.toHaveBeenCalled();
    });

    it('no-ops cancellation when the snapshot has no timeStart', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await setupRoutineWithEvent(userId);

        // Without timeStart the helper can't derive an original rrule date — skip gracefully.
        const item = makeItem(userId, {
            _id: 'item-trash-no-ts',
            routineId: 'routine-1',
            status: 'trash',
            timeStart: undefined,
            timeEnd: undefined,
        });

        const cancelSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'cancelRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(cancelSpy).not.toHaveBeenCalled();
    });

    it('skips per-instance override for a fromGmail routine-generated item', async () => {
        // Defensive: routine masters from Gmail don't exist in practice, but if eventType ever
        // mirrors through the GCal-owned routine keys, we don't want a 400 from GCal.
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await setupRoutineWithEvent(userId);

        const item = makeItem(userId, {
            _id: 'item-inst-fromgmail',
            routineId: 'routine-1',
            title: 'Gmail mirror instance',
            timeStart: '2026-05-04T11:00:00.000Z',
            timeEnd: '2026-05-04T11:30:00.000Z',
            eventType: 'fromGmail',
            status: 'done',
        });
        await itemsDAO.insertOne(item);

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(updateSpy).not.toHaveBeenCalled();
    });

    it('skips per-instance cancellation for a fromGmail routine-generated item', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await setupRoutineWithEvent(userId);

        const item = makeItem(userId, {
            _id: 'item-cancel-fromgmail',
            routineId: 'routine-1',
            title: 'Gmail mirror cancel',
            timeStart: '2026-05-04T11:00:00.000Z',
            timeEnd: '2026-05-04T11:30:00.000Z',
            eventType: 'fromGmail',
            status: 'trash',
        });
        await itemsDAO.insertOne(item);

        const cancelSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'cancelRecurringInstance').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        expect(cancelSpy).not.toHaveBeenCalled();
    });
});

describe('calendar push-back — failure surfacing (ops marked syncFailed)', () => {
    // Regression suite for the 2026-08-19 incident: a 9-item burst-trash hit Google's short-window
    // rate limit on 2 of the 9 instance-cancellation PATCHes, and the failures vanished into the
    // fire-and-forget console log — no syncFailed op, no SyncIssuesPanel row, no retry path. Every
    // GCal-mutating branch (not just the create paths) must now surface a provider failure onto
    // the driving op.

    function gcalRateLimitError() {
        // Gaxios shape of Google's short-window per-user write quota: HTTP 403 (not 429).
        return Object.assign(new Error('Rate Limit Exceeded'), {
            code: 403,
            errors: [{ message: 'Rate Limit Exceeded', domain: 'usageLimits', reason: 'rateLimitExceeded' }],
        });
    }

    function gcalServerError() {
        return Object.assign(new Error('Backend Error'), { code: 500 });
    }

    async function insertLinkedRoutine(userId: string, overrides: Partial<RoutineInterface> = {}) {
        const routine = makeRoutine(userId, {
            calendarEventId: 'recurring-master-1',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            ...overrides,
        });
        await routinesDAO.insertOne(routine);
        return routine;
    }

    /** Persists the op first (markOpFailed updates the row in place), pushes, and returns the post-push row. */
    async function pushPersistedOp(userId: string, overrides: Partial<OperationInterface>) {
        const op = makeOp(userId, overrides);
        await operationsDAO.insertOne(op);
        await maybePushToGCal(op, mockBuildProvider());
        return (await operationsDAO.findOne({ _id: op._id }))!;
    }

    it('marks the op transient_exhausted when a routine-instance cancellation is rate-limited (the silent-drop incident)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertLinkedRoutine(userId);

        const item = makeItem(userId, {
            _id: 'item-cancel-ratelimited',
            routineId: 'routine-1',
            status: 'trash',
            timeStart: '2026-08-25T06:45:00.000Z',
            timeEnd: '2026-08-25T07:00:00.000Z',
        });
        await itemsDAO.insertOne(item);

        vi.spyOn(GoogleCalendarProvider.prototype, 'cancelRecurringInstance').mockRejectedValue(gcalRateLimitError());

        const failed = await pushPersistedOp(userId, { _id: 'op-cancel-rl', entityType: 'item', entityId: item._id!, snapshot: item });

        expect(failed.syncFailed).toBe(true);
        expect(failed.failureReason).toBe('transient_exhausted');
        expect(failed.failureDetail).toContain('Rate Limit Exceeded');
        expect(failed.failedTs).toBeTruthy();
    });

    it('leaves the op unmarked when the cancellation succeeds', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertLinkedRoutine(userId);

        const item = makeItem(userId, {
            _id: 'item-cancel-ok',
            routineId: 'routine-1',
            status: 'trash',
            timeStart: '2026-08-25T06:45:00.000Z',
            timeEnd: '2026-08-25T07:00:00.000Z',
        });
        await itemsDAO.insertOne(item);

        vi.spyOn(GoogleCalendarProvider.prototype, 'cancelRecurringInstance').mockResolvedValue(undefined);

        const pushed = await pushPersistedOp(userId, { _id: 'op-cancel-ok', entityType: 'item', entityId: item._id!, snapshot: item });

        expect(pushed.syncFailed).toBeUndefined();
        expect(pushed.failureReason).toBeUndefined();
    });

    it('marks the op when a routine-instance override push fails', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertLinkedRoutine(userId);

        const item = makeItem(userId, {
            _id: 'item-override-500',
            routineId: 'routine-1',
            status: 'calendar',
            timeStart: '2026-08-25T06:45:00.000Z',
            timeEnd: '2026-08-25T07:00:00.000Z',
        });
        await itemsDAO.insertOne(item);

        vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringInstance').mockRejectedValue(gcalServerError());

        const failed = await pushPersistedOp(userId, { _id: 'op-override-500', entityType: 'item', entityId: item._id!, snapshot: item });

        expect(failed.syncFailed).toBe(true);
        expect(failed.failureReason).toBe('transient_exhausted');
    });

    it('marks the op when a standalone linked-item update fails', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            _id: 'item-update-500',
            calendarEventId: 'gcal-ev-500',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
        });
        await itemsDAO.insertOne(item);

        vi.spyOn(GoogleCalendarProvider.prototype, 'updateEvent').mockRejectedValue(gcalServerError());

        const failed = await pushPersistedOp(userId, { _id: 'op-update-500', entityType: 'item', entityId: item._id!, snapshot: item });

        expect(failed.syncFailed).toBe(true);
        expect(failed.failureReason).toBe('transient_exhausted');
    });

    it('marks the op when the GCal cleanup for a hard-deleted linked item fails', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Hydrated delete snapshot — the pre-delete row shape maybePushToGCal receives.
        const snapshot = makeItem(userId, {
            _id: 'item-hard-deleted',
            calendarEventId: 'gcal-ev-deleted',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'deleteEvent').mockRejectedValue(gcalRateLimitError());

        const failed = await pushPersistedOp(userId, { _id: 'op-delete-rl', entityType: 'item', entityId: snapshot._id!, opType: 'delete', snapshot });

        expect(failed.syncFailed).toBe(true);
        expect(failed.failureReason).toBe('transient_exhausted');
    });

    it('marks the op when the GCal removal for a calendar-detached item fails', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const detachedCalendar = makeItem(userId, {
            _id: 'item-detached',
            calendarEventId: 'gcal-ev-detached',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
        });
        // Post-detach snapshot: active status, GCal linkage stripped by the status matrix.
        const snapshot = makeItem(userId, { _id: 'item-detached', status: 'nextAction', timeStart: undefined, timeEnd: undefined });

        vi.spyOn(GoogleCalendarProvider.prototype, 'deleteEvent').mockRejectedValue(gcalServerError());

        const failed = await pushPersistedOp(userId, { _id: 'op-detach-500', entityType: 'item', entityId: 'item-detached', snapshot, detachedCalendar });

        expect(failed.syncFailed).toBe(true);
        expect(failed.failureReason).toBe('transient_exhausted');
    });

    it('marks the op when the pause cap fails, after the local item trash has already run', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        const routine = await insertLinkedRoutine(userId, { active: false });

        // Future generated occurrence the pause must trash regardless of the GCal outcome.
        const futureItem = makeItem(userId, {
            _id: 'item-pause-future',
            routineId: routine._id,
            status: 'calendar',
            timeStart: dayjs().add(7, 'day').toISOString(),
            timeEnd: dayjs().add(7, 'day').add(30, 'minute').toISOString(),
        });
        await itemsDAO.insertOne(futureItem);

        // Prior op with active:true so readPriorActiveFlag sees a pause transition.
        const priorTs = dayjs().subtract(1, 'minute').toISOString();
        await operationsDAO.insertOne(
            makeOp(userId, { _id: 'op-pause-prior', ts: priorTs, entityType: 'routine', entityId: routine._id, snapshot: { ...routine, active: true } }),
        );

        vi.spyOn(GoogleCalendarProvider.prototype, 'capRecurringEvent').mockRejectedValue(gcalRateLimitError());

        const failed = await pushPersistedOp(userId, { _id: 'op-pause-cap', entityType: 'routine', entityId: routine._id, snapshot: routine });

        expect(failed.syncFailed).toBe(true);
        expect(failed.failureReason).toBe('transient_exhausted');
        // The cap failure must not have blocked the local trash cascade that ran before it.
        const trashed = await itemsDAO.findByOwnerAndId(futureItem._id!, userId);
        expect(trashed!.status).toBe('trash');
    });

    it('marks the op when the resume series push fails, and still regenerates local items', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        const routine = await insertLinkedRoutine(userId, { active: true });

        // Prior op with active:false so readPriorActiveFlag sees a resume transition.
        const priorTs = dayjs().subtract(1, 'minute').toISOString();
        await operationsDAO.insertOne(
            makeOp(userId, { _id: 'op-resume-prior', ts: priorTs, entityType: 'routine', entityId: routine._id, snapshot: { ...routine, active: false } }),
        );

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringEvent').mockRejectedValue(gcalServerError());

        const failed = await pushPersistedOp(userId, { _id: 'op-resume-500', entityType: 'routine', entityId: routine._id, snapshot: routine });

        expect(updateSpy).toHaveBeenCalledOnce();
        expect(failed.syncFailed).toBe(true);
        expect(failed.failureReason).toBe('transient_exhausted');
        // Regen must have run despite the failed series push — future occurrences exist locally.
        const regenerated = await itemsDAO.findArray({ user: userId, routineId: routine._id, status: 'calendar' });
        expect(regenerated.length).toBeGreaterThan(0);
    });
});

describe('calendar push-back — routines', () => {
    it('updates GCal recurring event when routine changes', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const routine = makeRoutine(userId, {
            calendarEventId: 'gcal-recurring-1',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
        });
        await routinesDAO.insertOne(routine);

        const updateSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'updateRecurringEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'routine', entityId: routine._id, snapshot: routine }), mockBuildProvider());

        expect(updateSpy).toHaveBeenCalledWith('gcal-recurring-1', routine, 'primary', 'Asia/Jerusalem');
        // Verify lastPushedToGCalTs was stamped.
        const updated = await routinesDAO.findByOwnerAndId(routine._id, userId);
        expect(updated!.lastPushedToGCalTs).toBeTruthy();
    });

    it('creates GCal recurring event for a new calendar routine', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const routine = makeRoutine(userId, {
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
        });
        await routinesDAO.insertOne(routine);

        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('new-recurring-id');

        await maybePushToGCal(makeOp(userId, { entityType: 'routine', entityId: routine._id, snapshot: routine }), mockBuildProvider());

        expect(createSpy).toHaveBeenCalledOnce();
        const updated = await routinesDAO.findByOwnerAndId(routine._id, userId);
        expect(updated!.calendarEventId).toBe('new-recurring-id');
        expect(updated!.lastPushedToGCalTs).toBeTruthy();
    });

    it('skips routine creation when DB already has calendarEventId (concurrent push-back guard)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // Snapshot passed in the op lacks calendarEventId (captured at queue-time).
        const snapshotWithoutLink = makeRoutine(userId, {
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
        });

        // But the DB record already has it — a concurrent push-back linked it first.
        const routineInDb = makeRoutine(userId, {
            calendarEventId: 'already-linked',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
        });
        await routinesDAO.insertOne(routineInDb);

        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('duplicate-id');

        await maybePushToGCal(makeOp(userId, { entityType: 'routine', entityId: snapshotWithoutLink._id, snapshot: snapshotWithoutLink }), mockBuildProvider());

        expect(createSpy).not.toHaveBeenCalled();
    });

    it('skips non-calendar routines without calendarEventId', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const routine = makeRoutine(userId, {
            routineType: 'nextAction',
            calendarIntegrationId: 'int-1',
        });
        await routinesDAO.insertOne(routine);

        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('id');

        await maybePushToGCal(makeOp(userId, { entityType: 'routine', entityId: routine._id, snapshot: routine }), mockBuildProvider());

        expect(createSpy).not.toHaveBeenCalled();
    });

    it('skips calendar routines without calendarIntegrationId', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);

        const routine = makeRoutine(userId);
        await routinesDAO.insertOne(routine);

        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('id');

        await maybePushToGCal(makeOp(userId, { entityType: 'routine', entityId: routine._id, snapshot: routine }), mockBuildProvider());

        expect(createSpy).not.toHaveBeenCalled();
    });

    it('on routine delete: deletes GCal recurring event and trashes generated calendar items', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const routine = makeRoutine(userId, {
            _id: 'routine-del',
            calendarEventId: 'gcal-master-del',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
        });
        // Routine is NOT inserted into the DB: the caller (sync.ts) captures the snapshot pre-delete
        // and then applyEntityOp hard-deletes the doc. By the time maybePushToGCal runs, the routine
        // is already gone — the push-back must work off the snapshot alone.

        const now = dayjs().toISOString();
        await itemsDAO.insertMany([
            { _id: 'gen-1', user: userId, status: 'calendar', title: 'Standup Mon', routineId: 'routine-del', createdTs: now, updatedTs: now },
            { _id: 'gen-2', user: userId, status: 'calendar', title: 'Standup Mon next', routineId: 'routine-del', createdTs: now, updatedTs: now },
            // Unrelated item (no routineId) must NOT be touched.
            { _id: 'other', user: userId, status: 'calendar', title: 'Other cal item', createdTs: now, updatedTs: now },
            // Item belonging to a different routine must NOT be touched.
            {
                _id: 'other-routine-cal',
                user: userId,
                status: 'calendar',
                title: 'Other routine cal',
                routineId: 'routine-other',
                createdTs: now,
                updatedTs: now,
            },
            // Item with the same routineId but a non-calendar status IS also trashed — the
            // sibling nextAction cascade (trashGeneratedOpenNextActionItems) covers it.
            {
                _id: 'gen-nextaction',
                user: userId,
                status: 'nextAction',
                title: 'NA sibling',
                routineId: 'routine-del',
                createdTs: now,
                updatedTs: now,
            },
        ]);

        const deleteSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'deleteRecurringEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'routine', entityId: routine._id, opType: 'delete', snapshot: routine }), mockBuildProvider());

        expect(deleteSpy).toHaveBeenCalledWith('gcal-master-del', 'primary');

        const g1 = await itemsDAO.findOne({ _id: 'gen-1' });
        const g2 = await itemsDAO.findOne({ _id: 'gen-2' });
        const other = await itemsDAO.findOne({ _id: 'other' });
        const otherRoutine = await itemsDAO.findOne({ _id: 'other-routine-cal' });
        const naSibling = await itemsDAO.findOne({ _id: 'gen-nextaction' });
        expect(g1?.status).toBe('trash');
        expect(g2?.status).toBe('trash');
        expect(other?.status).toBe('calendar');
        expect(otherRoutine?.status).toBe('calendar');
        expect(naSibling?.status).toBe('trash');

        // Each cascade-trashed item records an update op so other devices sync the state change.
        const ops = await operationsDAO.findArray({ entityId: { $in: ['gen-1', 'gen-2', 'gen-nextaction'] } });
        expect(ops).toHaveLength(3);
        expect(ops.every((op) => op.opType === 'update' && op.snapshot?.status === 'trash')).toBe(true);
    });

    it('on routine delete without calendarEventId: trashes generated items but skips GCal call', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const routine = makeRoutine(userId, { _id: 'routine-nolink', routineType: 'nextAction' });
        // No calendarEventId — nothing to remove from GCal.

        const now = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'gen-nextaction',
            user: userId,
            status: 'calendar',
            title: 'Weird next-action with cal status',
            routineId: 'routine-nolink',
            createdTs: now,
            updatedTs: now,
        });

        const deleteSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'deleteRecurringEvent').mockResolvedValue(undefined);

        await maybePushToGCal(makeOp(userId, { entityType: 'routine', entityId: routine._id, opType: 'delete', snapshot: routine }), mockBuildProvider());

        expect(deleteSpy).not.toHaveBeenCalled();
        const item = await itemsDAO.findOne({ _id: 'gen-nextaction' });
        expect(item?.status).toBe('trash');
    });

    it('on routine delete: swallows GCal provider errors and still trashes generated items', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const routine = makeRoutine(userId, {
            _id: 'routine-err',
            calendarEventId: 'gcal-err-1',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
        });

        const now = dayjs().toISOString();
        await itemsDAO.insertOne({
            _id: 'gen-err',
            user: userId,
            status: 'calendar',
            title: 'Instance',
            routineId: 'routine-err',
            createdTs: now,
            updatedTs: now,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'deleteRecurringEvent').mockRejectedValue(new Error('boom'));

        // Must not throw: provider failure is best-effort.
        await expect(
            maybePushToGCal(makeOp(userId, { entityType: 'routine', entityId: routine._id, opType: 'delete', snapshot: routine }), mockBuildProvider()),
        ).resolves.toBeUndefined();

        const item = await itemsDAO.findOne({ _id: 'gen-err' });
        expect(item?.status).toBe('trash');
    });
});

describe('calendar push-back — concurrent in-flight guard', () => {
    it('creates only one GCal recurring event when two create ops race concurrently', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const routine = makeRoutine(userId, {
            _id: 'routine-concurrent-1',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
        });
        await routinesDAO.insertOne(routine);

        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockResolvedValue('new-recurring-id');

        const op = makeOp(userId, { entityType: 'routine', entityId: routine._id, snapshot: routine });
        // Fire two push-backs concurrently for the same entity — simulates back-to-back flush batches.
        await Promise.all([maybePushToGCal(op, mockBuildProvider()), maybePushToGCal(op, mockBuildProvider())]);

        expect(createSpy).toHaveBeenCalledOnce();
    });

    it('creates only one GCal event when two create item ops race concurrently', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, { _id: 'item-concurrent-1' });
        await itemsDAO.insertOne(item);

        const createSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockResolvedValue({ eventId: 'new-gcal-id' });

        const op = makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item });
        // Fire two push-backs concurrently for the same entity.
        await Promise.all([maybePushToGCal(op, mockBuildProvider()), maybePushToGCal(op, mockBuildProvider())]);

        expect(createSpy).toHaveBeenCalledOnce();
    });

    it('cleans up in-flight set when item GCal creation fails', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, { _id: 'item-error-cleanup-1' });
        await itemsDAO.insertOne(item);

        vi.spyOn(GoogleCalendarProvider.prototype, 'createEvent').mockRejectedValue(new Error('GCal API error'));

        const op = makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item });
        await maybePushToGCal(op, mockBuildProvider());

        // The in-flight set must be cleaned up so subsequent retries are not permanently blocked.
        expect(gcalCreationInFlight.has(item._id!)).toBe(false);
    });

    it('cleans up in-flight set when routine GCal creation fails', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const routine = makeRoutine(userId, {
            _id: 'routine-error-cleanup-1',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
        });
        await routinesDAO.insertOne(routine);

        vi.spyOn(GoogleCalendarProvider.prototype, 'createRecurringEvent').mockRejectedValue(new Error('GCal API error'));

        const op = makeOp(userId, { entityType: 'routine', entityId: routine._id, snapshot: routine });
        await maybePushToGCal(op, mockBuildProvider());

        expect(gcalCreationInFlight.has(routine._id)).toBe(false);
    });
});

// ─── Loop prevention (echo detection) ──────────────────────────────────────

describe('loop prevention — echo detection', () => {
    it('skips importing a GCal event that was recently pushed by the app', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const { integration } = await insertIntegrationWithConfig(userId);

        const now = dayjs().toISOString();
        // Item was pushed to GCal moments ago.
        const existingItem: ItemInterface = {
            _id: 'item-echo-1',
            user: userId,
            status: 'calendar',
            title: 'Echoed Event',
            timeStart: dayjs().add(1, 'day').toISOString(),
            timeEnd: dayjs().add(1, 'day').add(1, 'hour').toISOString(),
            calendarEventId: 'gcal-echo-1',
            calendarIntegrationId: integration._id,
            calendarSyncConfigId: 'sync-config-1',
            lastPushedToGCalTs: now,
            createdTs: now,
            updatedTs: now,
        };
        await itemsDAO.insertOne(existingItem);

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        // The event's `updated` timestamp is within the 5-second echo window.
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-echo-1',
                    title: 'Echoed Event — from GCal',
                    timeStart: existingItem.timeStart!,
                    timeEnd: existingItem.timeEnd!,
                    updated: dayjs().add(2, 'second').toISOString(),
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-echo',
        });

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/integrations/int-1/sync',
            sessionCookie,
        });
        expect(res.status).toBe(200);

        // The item should NOT have been updated with the GCal title — echo was detected.
        const item = await itemsDAO.findByOwnerAndId('item-echo-1', userId);
        expect(item!.title).toBe('Echoed Event');
    });

    it('imports GCal event when outside the echo window', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        const { integration } = await insertIntegrationWithConfig(userId);

        const twoMinutesAgo = dayjs().subtract(2, 'minute').toISOString();
        const existingItem: ItemInterface = {
            _id: 'item-echo-2',
            user: userId,
            status: 'calendar',
            title: 'Old Event',
            timeStart: dayjs().add(1, 'day').toISOString(),
            timeEnd: dayjs().add(1, 'day').add(1, 'hour').toISOString(),
            calendarEventId: 'gcal-echo-2',
            calendarIntegrationId: integration._id,
            calendarSyncConfigId: 'sync-config-1',
            lastPushedToGCalTs: twoMinutesAgo,
            createdTs: twoMinutesAgo,
            updatedTs: twoMinutesAgo,
        };
        await itemsDAO.insertOne(existingItem);

        vi.spyOn(GoogleCalendarProvider.prototype, 'getExceptions').mockResolvedValue([]);
        vi.spyOn(GoogleCalendarProvider.prototype, 'listEventsFull').mockResolvedValue({
            events: [
                {
                    id: 'gcal-echo-2',
                    title: 'Updated by someone else',
                    timeStart: existingItem.timeStart!,
                    timeEnd: existingItem.timeEnd!,
                    updated: dayjs().toISOString(),
                    status: 'confirmed',
                },
            ],
            nextSyncToken: 'tok-echo-2',
        });

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/integrations/int-1/sync',
            sessionCookie,
        });
        expect(res.status).toBe(200);

        // The item SHOULD have been updated — outside the echo window.
        const item = await itemsDAO.findByOwnerAndId('item-echo-2', userId);
        expect(item!.title).toBe('Updated by someone else');
    });
});

// ─── findNeedingWebhook ────────────────────────────────────────────────────

describe('findNeedingWebhook', () => {
    it('returns enabled configs with no webhookExpiry', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const horizon = dayjs().add(1, 'day').toISOString();
        const results = await calendarSyncConfigsDAO.findNeedingWebhook(horizon);
        expect(results).toHaveLength(1);
        expect(results[0]._id).toBe('sync-config-1');
    });

    it('returns enabled configs with expired webhookExpiry', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await calendarSyncConfigsDAO.upsertWebhookFields('sync-config-1', 'ch', 'res', dayjs().subtract(1, 'hour').toISOString());

        const horizon = dayjs().add(1, 'day').toISOString();
        const results = await calendarSyncConfigsDAO.findNeedingWebhook(horizon);
        expect(results).toHaveLength(1);
    });

    it('excludes disabled configs', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await calendarSyncConfigsDAO.updateOne({ _id: 'sync-config-1' } as never, { $set: { enabled: false } });

        const horizon = dayjs().add(1, 'day').toISOString();
        const results = await calendarSyncConfigsDAO.findNeedingWebhook(horizon);
        expect(results).toHaveLength(0);
    });

    it('excludes configs with webhookExpiry beyond the horizon', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await calendarSyncConfigsDAO.upsertWebhookFields('sync-config-1', 'ch', 'res', dayjs().add(5, 'day').toISOString());

        const horizon = dayjs().add(1, 'day').toISOString();
        const results = await calendarSyncConfigsDAO.findNeedingWebhook(horizon);
        expect(results).toHaveLength(0);
    });
});

describe('calendar push-back — all-day items (outbound)', () => {
    it('createEvent for an all-day item emits { date } start/end with no timeZone', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // All-day item: timeStart/timeEnd are YYYY-MM-DD strings (GCal's exclusive-end convention).
        const item = makeItem(userId, {
            allDay: true,
            timeStart: '2026-05-27',
            timeEnd: '2026-05-28',
        });
        await itemsDAO.insertOne(item);

        const { insertSpy } = spyOnGCalEventsApi();

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        const params = getInsertRequestBody(insertSpy);
        expect(params.requestBody?.start).toEqual({ date: '2026-05-27' });
        expect(params.requestBody?.end).toEqual({ date: '2026-05-28' });
        // No timeZone field at all on the start/end objects — GCal must treat them as owner-local.
        expect(params.requestBody?.start).not.toHaveProperty('timeZone');
        expect(params.requestBody?.end).not.toHaveProperty('timeZone');
    });

    it('updateEvent for an all-day item emits { date } start/end (no timeZone)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            calendarEventId: 'gcal-allday-update',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            allDay: true,
            timeStart: '2026-05-27',
            timeEnd: '2026-05-28',
        });
        await itemsDAO.insertOne(item);

        const { patchSpy } = spyOnGCalEventsApi();

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        const params = getPatchRequestBody(patchSpy);
        expect(params.requestBody?.start).toEqual({ date: '2026-05-27' });
        expect(params.requestBody?.end).toEqual({ date: '2026-05-28' });
    });

    it('createRecurringEvent for an all-day template emits { date } start/end and the routine rrule', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        // All-day calendar routine: template { allDay: true } with no timeOfDay/duration.
        const routine = makeRoutine(userId, {
            _id: 'routine-allday',
            rrule: 'FREQ=WEEKLY;BYDAY=MO',
            startDate: '2026-05-25',
            calendarItemTemplate: { allDay: true },
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
        });
        await routinesDAO.insertOne(routine);

        const { insertSpy } = spyOnGCalEventsApi();

        await maybePushToGCal(makeOp(userId, { entityType: 'routine', entityId: routine._id, snapshot: routine }), mockBuildProvider());

        const params = getInsertRequestBody(insertSpy);
        // start.date = the rrule-anchored series start (Monday 2026-05-25). end = start + 1 day.
        expect(params.requestBody?.start).toEqual({ date: '2026-05-25' });
        expect(params.requestBody?.end).toEqual({ date: '2026-05-26' });
        expect(params.requestBody?.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=MO']);
    });
});

describe('calendar push-back — htmlLink capture (outbound)', () => {
    // Exercises the real GoogleCalendarProvider mapping (googleapis-level insert mock), not a
    // provider-method mock: the insert response's htmlLink must survive createEvent's return
    // shape and land on the item row in the same write as the link fields.
    it('stamps the insert response htmlLink on the newly linked item', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, { _id: 'item-htmllink-1' });
        await itemsDAO.insertOne(item);

        const { insertSpy } = spyOnGCalEventsApi();
        insertSpy.mockResolvedValue({ data: { id: 'gcal-htmllink-1', htmlLink: 'https://www.google.com/calendar/event?eid=aHRtbA' } });

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        const linked = await itemsDAO.findByOwnerAndId('item-htmllink-1', userId);
        expect(linked?.calendarEventId).toBe('gcal-htmllink-1');
        expect(linked?.htmlLink).toBe('https://www.google.com/calendar/event?eid=aHRtbA');
    });
});

describe('calendar push-back — attendees + sendUpdates threading', () => {
    it('updateEvent forwards the full attendees array verbatim in requestBody', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const attendees = [
            { email: 'alice@example.com', responseStatus: 'accepted' as const },
            { email: 'bob@example.com', responseStatus: 'needsAction' as const, displayName: 'Bob' },
        ];
        const item = makeItem(userId, {
            calendarEventId: 'gcal-with-attendees',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            attendees,
        });
        await itemsDAO.insertOne(item);

        const { patchSpy } = spyOnGCalEventsApi();

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        const params = getPatchRequestBody(patchSpy);
        expect(params.requestBody?.attendees).toEqual(attendees);
    });

    it("op gcalMeta.sendUpdates='all' propagates to events.patch sendUpdates param", async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            calendarEventId: 'gcal-send-all',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
        });
        await itemsDAO.insertOne(item);

        const { patchSpy } = spyOnGCalEventsApi();

        await maybePushToGCal(
            makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item, gcalMeta: { sendUpdates: 'all' } }),
            mockBuildProvider(),
        );

        const params = getPatchRequestBody(patchSpy);
        expect(params.sendUpdates).toBe('all');
    });

    it("op gcalMeta.sendUpdates='all' propagates to events.insert sendUpdates param on create", async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId); // no calendarEventId yet → create path
        await itemsDAO.insertOne(item);

        const { insertSpy } = spyOnGCalEventsApi();

        await maybePushToGCal(
            makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item, gcalMeta: { sendUpdates: 'all' } }),
            mockBuildProvider(),
        );

        const params = getInsertRequestBody(insertSpy);
        expect(params.sendUpdates).toBe('all');
    });

    it("absent gcalMeta defaults sendUpdates to 'none' on events.patch (silent edit)", async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            calendarEventId: 'gcal-silent',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
        });
        await itemsDAO.insertOne(item);

        const { patchSpy } = spyOnGCalEventsApi();

        // No gcalMeta on the op → default path.
        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id!, snapshot: item }), mockBuildProvider());

        const params = getPatchRequestBody(patchSpy);
        expect(params.sendUpdates).toBe('none');
    });

    it('routine-instance override omits attendees when they match the routine master (server-side detach gate)', async () => {
        // Server-side detach gate: when the snapshot attendees match the routine master attendees,
        // the pushback skips the `attendees` field so a title/time/notes edit does NOT silently
        // fork the instance per RFC 5545. The UI's detach-warning dialog covers the membership-change
        // case; the server gate covers everything else (including replayed legacy ops).
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const masterAttendees = [{ email: 'master-attendee@example.com', responseStatus: 'accepted' as const }];
        const routine = makeRoutine(userId, {
            _id: 'routine-with-attendees-master',
            calendarEventId: 'gcal-master-attendees',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            attendees: masterAttendees,
        });
        await routinesDAO.insertOne(routine);

        const occurrenceTs = dayjs().add(1, 'day').toISOString();
        const item = makeItem(userId, {
            _id: 'item-routine-instance-attendees',
            routineId: routine._id,
            timeStart: occurrenceTs,
            timeEnd: dayjs(occurrenceTs).add(30, 'minute').toISOString(),
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            attendees: masterAttendees, // identical to routine.attendees ⇒ inheritance preserved
        });
        await itemsDAO.insertOne(item);

        const { patchSpy } = spyOnGCalEventsApi();

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id ?? '', snapshot: item }), mockBuildProvider());

        const params = getPatchRequestBody(patchSpy);
        expect(params.requestBody).not.toHaveProperty('attendees');
    });

    it('routine-instance override forwards attendees when they diverge from the routine master (detach gesture)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const masterAttendees = [{ email: 'master-attendee@example.com', responseStatus: 'accepted' as const }];
        const routine = makeRoutine(userId, {
            _id: 'routine-with-attendees-master-2',
            calendarEventId: 'gcal-master-attendees-2',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            attendees: masterAttendees,
        });
        await routinesDAO.insertOne(routine);

        // User added a second attendee on this specific date — the snapshot diverges from the master.
        const divergentAttendees = [
            { email: 'master-attendee@example.com', responseStatus: 'accepted' as const },
            { email: 'guest@example.com', responseStatus: 'needsAction' as const },
        ];
        const occurrenceTs = dayjs().add(1, 'day').toISOString();
        const item = makeItem(userId, {
            _id: 'item-routine-instance-attendees-2',
            routineId: routine._id,
            timeStart: occurrenceTs,
            timeEnd: dayjs(occurrenceTs).add(30, 'minute').toISOString(),
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            attendees: divergentAttendees,
        });
        await itemsDAO.insertOne(item);

        const { patchSpy } = spyOnGCalEventsApi();

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id ?? '', snapshot: item }), mockBuildProvider());

        const params = getPatchRequestBody(patchSpy);
        expect(params.requestBody).toHaveProperty('attendees');
        expect(params.requestBody.attendees).toEqual(divergentAttendees);
    });

    it('all-day item done-marker push emits { date } start/end (not { dateTime })', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const item = makeItem(userId, {
            calendarEventId: 'gcal-allday-done',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            allDay: true,
            timeStart: '2026-05-27',
            timeEnd: '2026-05-28',
            status: 'done',
        });
        await itemsDAO.insertOne(item);

        const { patchSpy } = spyOnGCalEventsApi();

        await maybePushToGCal(makeOp(userId, { entityType: 'item', entityId: item._id ?? '', snapshot: item }), mockBuildProvider());

        const params = getPatchRequestBody(patchSpy);
        expect(params.requestBody?.start).toEqual({ date: '2026-05-27' });
        expect(params.requestBody?.end).toEqual({ date: '2026-05-28' });
    });
});

// ─── Phase 3: RSVP endpoint + scope-missing re-consent ────────────────────────

describe('POST /calendar/items/:itemId/rsvp', () => {
    /** Inserts a linked calendar item with an existing self attendee in `needsAction`. */
    async function insertLinkedCalendarItem(userId: string, overrides: Partial<ItemInterface> = {}): Promise<ItemInterface> {
        const item = makeItem(userId, {
            _id: 'item-rsvp-1',
            calendarEventId: 'gcal-rsvp-ev',
            calendarIntegrationId: 'int-1',
            calendarSyncConfigId: 'sync-config-1',
            attendees: [
                { email: 'alice@example.com', responseStatus: 'needsAction', self: true },
                { email: 'organizer@example.com', responseStatus: 'accepted', organizer: true },
            ],
            responseStatus: 'needsAction',
            ...overrides,
        });
        await itemsDAO.insertOne(item);
        return item;
    }

    it('updates the existing self attendee and stamps the item on success', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertLinkedCalendarItem(userId);

        // Skip the userinfo round-trip — the spy returns alice's email so it matches the self entry.
        vi.spyOn(GoogleCalendarProvider.prototype, 'getMyEmail').mockResolvedValueOnce('alice@example.com');
        const patchSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'patchEventAttendees').mockResolvedValueOnce(undefined);

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/items/item-rsvp-1/rsvp',
            sessionCookie,
            body: { responseStatus: 'accepted' },
        });
        expect(res.status).toBe(200);

        // sendUpdates:'all' propagates so the organizer sees the chip flip in real time.
        expect(patchSpy).toHaveBeenCalledOnce();
        const [args] = patchSpy.mock.calls;
        if (!args) throw new Error('expected one patch call');
        const [calendarId, eventId, attendees, options] = args;
        expect(calendarId).toBe('primary');
        expect(eventId).toBe('gcal-rsvp-ev');
        expect(options).toEqual({ sendUpdates: 'all' });
        // Attendees sorted by email; self entry updated to accepted; other entries preserved.
        expect(attendees).toEqual([
            { email: 'alice@example.com', responseStatus: 'accepted', self: true },
            { email: 'organizer@example.com', responseStatus: 'accepted', organizer: true },
        ]);

        const stored = await itemsDAO.findByOwnerAndId('item-rsvp-1', userId);
        expect(stored?.responseStatus).toBe('accepted');
        expect(stored?.attendees?.find((a) => a.self)?.responseStatus).toBe('accepted');
        expect(stored?.lastPushedToGCalTs).toBeDefined();
    });

    it("records an opType:'rsvp' op with the rsvp sidecar", async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertLinkedCalendarItem(userId);

        vi.spyOn(GoogleCalendarProvider.prototype, 'getMyEmail').mockResolvedValueOnce('alice@example.com');
        vi.spyOn(GoogleCalendarProvider.prototype, 'patchEventAttendees').mockResolvedValueOnce(undefined);

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/items/item-rsvp-1/rsvp',
            sessionCookie,
            body: { responseStatus: 'declined' },
        });
        expect(res.status).toBe(200);

        const ops = await operationsDAO.findArray({ user: userId, entityId: 'item-rsvp-1' });
        const rsvpOps = ops.filter((o) => o.opType === 'rsvp');
        expect(rsvpOps).toHaveLength(1);
        const [op] = rsvpOps;
        if (!op) throw new Error('expected one rsvp op');
        expect(op.snapshot).toBeNull();
        expect(op.rsvp).toEqual({
            itemId: 'item-rsvp-1',
            calendarEventId: 'gcal-rsvp-ev',
            calendarIntegrationId: 'int-1',
            responseStatus: 'declined',
        });
    });

    it('appends a self attendee when none exists yet', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertLinkedCalendarItem(userId, {
            // No self entry — the user wasn't on the invite list (e.g. delegated mailbox case).
            attendees: [{ email: 'organizer@example.com', responseStatus: 'accepted', organizer: true }],
            responseStatus: undefined,
        });

        vi.spyOn(GoogleCalendarProvider.prototype, 'getMyEmail').mockResolvedValueOnce('alice@example.com');
        const patchSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'patchEventAttendees').mockResolvedValueOnce(undefined);

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/items/item-rsvp-1/rsvp',
            sessionCookie,
            body: { responseStatus: 'tentative' },
        });
        expect(res.status).toBe(200);

        const [args] = patchSpy.mock.calls;
        if (!args) throw new Error('expected one patch call');
        const [, , attendees] = args;
        // Sorted by email — alice comes before organizer alphabetically.
        expect(attendees).toEqual([
            { email: 'alice@example.com', responseStatus: 'tentative', self: true },
            { email: 'organizer@example.com', responseStatus: 'accepted', organizer: true },
        ]);

        const stored = await itemsDAO.findByOwnerAndId('item-rsvp-1', userId);
        expect(stored?.attendees).toHaveLength(2);
        expect(stored?.responseStatus).toBe('tentative');
    });

    it('returns 403 scope_missing when grantedScopes lacks calendar write', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId, {
            // Only the email scope was granted — RSVP requires calendar or calendar.events.
            grantedScopes: ['https://www.googleapis.com/auth/userinfo.email'],
        });
        await insertLinkedCalendarItem(userId);

        const patchSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'patchEventAttendees').mockResolvedValueOnce(undefined);

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/items/item-rsvp-1/rsvp',
            sessionCookie,
            body: { responseStatus: 'accepted' },
        });
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: string; reconsentUrl: string };
        expect(body.error).toBe('scope_missing');
        expect(body.reconsentUrl).toContain('/calendar/auth/google');
        expect(body.reconsentUrl).toContain('intent=rsvp');
        // The active session is alice@example.com (set up by oauthLogin); login_hint pre-fills the picker.
        expect(body.reconsentUrl).toContain('login_hint=alice');

        // No push was attempted — the gate rejected before reaching the provider.
        expect(patchSpy).not.toHaveBeenCalled();
    });

    it('treats absent grantedScopes as permissive (legacy integrations)', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        // grantedScopes omitted — the integration predates Phase 3 scope persistence.
        await insertIntegrationWithConfig(userId);
        await insertLinkedCalendarItem(userId);

        vi.spyOn(GoogleCalendarProvider.prototype, 'getMyEmail').mockResolvedValueOnce('alice@example.com');
        const patchSpy = vi.spyOn(GoogleCalendarProvider.prototype, 'patchEventAttendees').mockResolvedValueOnce(undefined);

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/items/item-rsvp-1/rsvp',
            sessionCookie,
            body: { responseStatus: 'accepted' },
        });
        expect(res.status).toBe(200);
        expect(patchSpy).toHaveBeenCalledOnce();
    });

    it('returns 404 when the item does not exist', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/items/no-such-item/rsvp',
            sessionCookie,
            body: { responseStatus: 'accepted' },
        });
        expect(res.status).toBe(404);
    });

    it('returns 400 when the item is not a calendar item', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        // nextAction item — no calendarEventId either, so the calendar-shape guard rejects.
        await itemsDAO.insertOne(makeItem(userId, { _id: 'item-na-1', status: 'nextAction', calendarEventId: undefined, calendarIntegrationId: undefined }));

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/items/item-na-1/rsvp',
            sessionCookie,
            body: { responseStatus: 'accepted' },
        });
        expect(res.status).toBe(400);
    });

    it('returns 400 when responseStatus is invalid', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertLinkedCalendarItem(userId);

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/items/item-rsvp-1/rsvp',
            sessionCookie,
            body: { responseStatus: 'maybe' },
        });
        expect(res.status).toBe(400);
    });

    it('returns 500 rsvp_push_failed and does not mutate the local item when the GCal patch throws', async () => {
        const sessionCookie = await loginAsAlice();
        const userId = await getUserId(sessionCookie);
        await insertIntegrationWithConfig(userId);
        await insertLinkedCalendarItem(userId);

        vi.spyOn(GoogleCalendarProvider.prototype, 'getMyEmail').mockResolvedValueOnce('alice@example.com');
        vi.spyOn(GoogleCalendarProvider.prototype, 'patchEventAttendees').mockRejectedValueOnce(new Error('gcal exploded'));

        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/items/item-rsvp-1/rsvp',
            sessionCookie,
            body: { responseStatus: 'accepted' },
        });
        expect(res.status).toBe(500);
        const body = (await res.json()) as { error: string; message: string };
        expect(body.error).toBe('rsvp_push_failed');
        expect(body.message).toContain('gcal exploded');

        // Local state unchanged — the client is expected to roll back its optimistic UI.
        const stored = await itemsDAO.findByOwnerAndId('item-rsvp-1', userId);
        expect(stored?.responseStatus).toBe('needsAction');
    });

    it("tenant isolation: user B cannot RSVP on user A's calendar item (returns 404)", async () => {
        // Set up user A with a calendar item.
        const aliceCookie = await loginAsAlice();
        const aliceId = await getUserId(aliceCookie);
        await insertIntegrationWithConfig(aliceId);
        await insertLinkedCalendarItem(aliceId);

        // Log in as user B via GitHub — Google's test mock always returns sub:g1, so a second
        // Google login would link back to alice. Routing bob through GitHub gives us a distinct user.
        const { sessionCookie: bobCookieRaw } = await oauthLogin(app, 'github', { email: 'bob@example.com', login: 'bob-gh' });
        if (!bobCookieRaw) throw new Error('expected bob session cookie');
        const bobCookie = bobCookieRaw;
        const bobId = await getUserId(bobCookie);
        expect(bobId).not.toBe(aliceId);

        // No spies set up — if isolation fails and the handler reaches the provider, the test
        // crashes on the unmocked network call, surfacing the leak loud and clear.
        const res = await authenticatedRequest(app, {
            method: 'POST',
            path: '/calendar/items/item-rsvp-1/rsvp',
            sessionCookie: bobCookie,
            body: { responseStatus: 'accepted' },
        });
        expect(res.status).toBe(404);

        // Alice's item is untouched.
        const aliceItem = await itemsDAO.findByOwnerAndId('item-rsvp-1', aliceId);
        expect(aliceItem?.responseStatus).toBe('needsAction');
    });
});
