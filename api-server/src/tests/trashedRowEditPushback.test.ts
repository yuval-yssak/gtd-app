/**
 * Google removal is a transition, not a state: only the op that moves an item INTO trash deletes
 * its event or cancels its routine occurrence. A later edit of an already-trashed row (a notes fix
 * in the app, a `/v1` PATCH) must leave Google alone — otherwise the first edit of a missed
 * occurrence, whose Google instance was deliberately kept as history, would cancel it after all.
 */
import dayjs from 'dayjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { applyAndPublishOperation, applyAndPublishOperations } from '../lib/applyOperation.js';
import { maybePushToGCal } from '../lib/calendarPushback.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import type {
    CalendarIntegrationInterface,
    CalendarSyncConfigInterface,
    ItemInterface,
    ItemStatus,
    OperationInterface,
    RoutineInterface,
} from '../types/entities.js';

beforeAll(async () => {
    await loadDataAccess('gtd_test');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all(['items', 'routines', 'operations', 'calendarIntegrations', 'calendarSyncConfigs'].map((name) => db.collection(name).deleteMany({})));
    vi.restoreAllMocks();
});

const userId = 'user-trashed-row-edit';
const integrationId = 'integ-trashed-edit';
const configId = 'config-trashed-edit';

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

async function seedLinkedRoutine() {
    const routine: RoutineInterface = {
        _id: 'routine-trashed-edit',
        user: userId,
        title: 'Daily standup',
        routineType: 'calendar',
        rrule: 'FREQ=DAILY',
        template: {},
        active: true,
        createdTs: '2026-05-01T00:00:00Z',
        updatedTs: '2026-05-01T00:00:00Z',
        calendarEventId: 'gcal-master-trashed-edit',
        calendarIntegrationId: integrationId,
        calendarSyncConfigId: configId,
    };
    await routinesDAO.insertOne(routine);
}

function occurrence(status: ItemStatus, overrides: Partial<ItemInterface> = {}): ItemInterface {
    return {
        _id: 'item-trashed-edit',
        user: userId,
        status,
        title: 'Daily standup',
        routineId: 'routine-trashed-edit',
        timeStart: '2026-05-20T09:00:00Z',
        timeEnd: '2026-05-20T09:15:00Z',
        calendarInstanceEventId: 'gcal-master-trashed-edit_20260520T090000Z',
        createdTs: '2026-05-10T00:00:00Z',
        updatedTs: '2026-05-10T00:00:00Z',
        ...overrides,
    };
}

function standalone(status: ItemStatus, overrides: Partial<ItemInterface> = {}): ItemInterface {
    return {
        _id: 'item-standalone-trashed-edit',
        user: userId,
        status,
        title: 'Dentist',
        timeStart: '2026-05-20T12:00:00Z',
        timeEnd: '2026-05-20T13:00:00Z',
        calendarEventId: 'gcal-standalone-trashed-edit',
        calendarIntegrationId: integrationId,
        calendarSyncConfigId: configId,
        createdTs: '2026-05-10T00:00:00Z',
        updatedTs: '2026-05-10T00:00:00Z',
        ...overrides,
    };
}

/** Applies an item update op through the real pipeline, then runs its pushback against a fake Google. */
async function applyAndPush(snapshot: ItemInterface) {
    const google = {
        cancelRecurringInstance: vi.fn().mockResolvedValue(undefined),
        deleteEvent: vi.fn().mockResolvedValue(undefined),
        getCalendarTimeZone: vi.fn().mockResolvedValue('UTC'),
    };
    const op = await applyAndPublishOperation(userId, { entityType: 'item', opType: 'update', entityId: snapshot._id ?? '', snapshot }, { deviceId: 'dev-1' });
    await maybePushToGCal(op, () => google as never);
    return { op, google };
}

describe('pushback removes from Google only on the move into trash', () => {
    it('cancels the routine occurrence on the op that trashes it', async () => {
        await seedCalendarIntegration();
        await seedLinkedRoutine();
        await itemsDAO.insertOne(occurrence('calendar'));

        const { op, google } = await applyAndPush(occurrence('trash', { updatedTs: dayjs().toISOString() }));

        expect(op.rowAlreadyTrash).toBeUndefined();
        expect(google.cancelRecurringInstance).toHaveBeenCalledOnce();
    });

    it('leaves the Google occurrence alone when an already-trashed occurrence is edited', async () => {
        await seedCalendarIntegration();
        await seedLinkedRoutine();
        await itemsDAO.insertOne(occurrence('trash'));

        const { op, google } = await applyAndPush(occurrence('trash', { notes: 'fixed a typo', updatedTs: dayjs().toISOString() }));

        expect(op.rowAlreadyTrash).toBe(true);
        expect(google.cancelRecurringInstance).not.toHaveBeenCalled();
    });

    it('leaves a standalone Google event alone when an already-trashed item is edited', async () => {
        await seedCalendarIntegration();
        await itemsDAO.insertOne(standalone('trash'));

        const { google } = await applyAndPush(standalone('trash', { notes: 'fixed a typo', updatedTs: dayjs().toISOString() }));

        expect(google.deleteEvent).not.toHaveBeenCalled();
    });

    it('treats an edit queued behind the trash in the SAME push batch as an edit of a trashed row', async () => {
        // An offline device flushes "missed" + a later notes fix together; the stored row is still
        // `calendar` when both are hydrated, so the batch itself must tell the second op apart.
        await seedCalendarIntegration();
        await seedLinkedRoutine();
        await itemsDAO.insertOne(occurrence('calendar'));
        const trashedAt = dayjs().subtract(1, 'second').toISOString();

        const { ops } = await applyAndPublishOperations(
            userId,
            [
                {
                    entityType: 'item',
                    opType: 'update',
                    entityId: 'item-trashed-edit',
                    snapshot: occurrence('trash', { updatedTs: trashedAt }),
                    gcalMeta: { sendUpdates: 'none', keepGoogleEvent: true },
                },
                {
                    entityType: 'item',
                    opType: 'update',
                    entityId: 'item-trashed-edit',
                    snapshot: occurrence('trash', { notes: 'later', updatedTs: dayjs().toISOString() }),
                },
            ],
            { deviceId: 'dev-1' },
        );

        expect(ops.map((op) => op.rowAlreadyTrash)).toEqual([undefined, true]);
        const [, edit] = ops;
        if (!edit) {
            throw new Error('expected the edit op');
        }
        // Persisted on the op, so a Retry replays the same decision.
        expect((await db.collection<OperationInterface>('operations').findOne({ _id: edit._id }))?.rowAlreadyTrash).toBe(true);
        const google = { cancelRecurringInstance: vi.fn().mockResolvedValue(undefined), getCalendarTimeZone: vi.fn().mockResolvedValue('UTC') };
        await Promise.all(ops.map((op) => maybePushToGCal(op, () => google as never)));
        expect(google.cancelRecurringInstance).not.toHaveBeenCalled();
    });
});
