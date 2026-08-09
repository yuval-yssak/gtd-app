/**
 * Tests for the missed-push sweep: edits made while a calendar integration was suspended/revoked
 * are dropped by the per-op pushback and were previously never retried, leaving the GCal event
 * permanently stale (the "moved routine instance never reaches Google" bug). The sweep runs inside
 * "Sync now", re-pushing linked items whose `updatedTs` post-dates every sync anchor, and
 * backfills `calendarInstanceEventId` on legacy routine items so the push patches the already-moved
 * instance by id instead of the date-window lookup that misses it.
 */
import dayjs from 'dayjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { isMissedPush, runMissedPushSweep } from '../lib/calendarPushback.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { applyExceptionToItems } from '../routes/calendar.js';
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

const userId = 'user-missed-push-sweep';
const integrationId = 'integ-mps-1';
const configId = 'config-mps-1';
const masterEventId = 'gcal-master-mps';

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
        timeZone: 'Asia/Jerusalem',
        createdTs: now,
        updatedTs: now,
    };
    await calendarIntegrationsDAO.insertEncrypted(integration);
    await calendarSyncConfigsDAO.insertOne(config);
}

/** Linked routine with a `modified` exception referencing the moved item — the sweep's proof of divergence. */
function linkedRoutine(overrides: Partial<RoutineInterface> = {}): RoutineInterface {
    return {
        _id: 'routine-mps-1',
        user: userId,
        title: 'Water the ferns',
        routineType: 'calendar',
        rrule: 'FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=1',
        active: true,
        calendarItemTemplate: { timeOfDay: '10:00', duration: 15 },
        template: {},
        calendarEventId: masterEventId,
        calendarIntegrationId: integrationId,
        calendarSyncConfigId: configId,
        lastSyncedFromGCalTs: '2026-06-05T12:00:00.000Z',
        routineExceptions: [{ date: '2026-08-01', type: 'modified', itemId: 'item-mps-moved', newTimeStart: '2026-08-05T13:30:00.000Z' }],
        createdTs: '2025-02-01T08:00:00.000Z',
        updatedTs: '2026-08-08T16:34:01.391Z',
        ...overrides,
    };
}

/** Legacy moved routine item: edited after the last inbound sync, never pushed, no anchors of its own. */
function movedRoutineItem(overrides: Partial<ItemInterface> = {}): ItemInterface {
    return {
        _id: 'item-mps-moved',
        user: userId,
        status: 'calendar',
        title: 'Water the ferns',
        routineId: 'routine-mps-1',
        timeStart: '2026-08-16T04:00:00.000Z',
        timeEnd: '2026-08-16T04:15:00.000Z',
        createdTs: '2026-06-18T18:24:08.808Z',
        updatedTs: '2026-08-08T16:34:01.387Z',
        ...overrides,
    };
}

function fakeProvider() {
    return {
        updateRecurringInstance: vi.fn().mockResolvedValue(undefined),
        updateEvent: vi.fn().mockResolvedValue(undefined),
        // Trash routes to cancelRecurringInstance — the fake must define it or the status-filter
        // test passes vacuously (asserting on a method the trash path never calls).
        cancelRecurringInstance: vi.fn().mockResolvedValue(undefined),
        getCalendarTimeZone: vi.fn().mockResolvedValue('Asia/Jerusalem'),
    };
}

describe('isMissedPush', () => {
    it('is true when updatedTs post-dates the only anchor', () => {
        expect(isMissedPush({ updatedTs: '2026-08-08T16:34:00Z', lastPushedToGCalTs: '2026-08-01T00:00:00Z' })).toBe(true);
    });

    it('is false when the latest anchor post-dates updatedTs (inbound echo)', () => {
        expect(isMissedPush({ updatedTs: '2026-08-01T00:00:00Z', lastSyncedFromGCalTs: '2026-08-02T00:00:00Z' })).toBe(false);
    });

    it('is false on the exact-equal boundary (an inbound apply stamps both to the same instant)', () => {
        expect(isMissedPush({ updatedTs: '2026-08-02T00:00:00Z', lastSyncedFromGCalTs: '2026-08-02T00:00:00Z' })).toBe(false);
    });

    it('is false with no anchors at all — no evidence which side is newer', () => {
        expect(isMissedPush({ updatedTs: '2026-08-08T16:34:00Z' })).toBe(false);
    });

    it('uses the fallback anchor for legacy rows without item-level anchors', () => {
        expect(isMissedPush({ updatedTs: '2026-08-08T16:34:00Z' }, '2026-06-05T12:00:00Z')).toBe(true);
        expect(isMissedPush({ updatedTs: '2026-05-01T00:00:00Z' }, '2026-06-05T12:00:00Z')).toBe(false);
    });

    it('compares against the LATEST of all anchors', () => {
        expect(
            isMissedPush({ updatedTs: '2026-08-08T00:00:00Z', lastPushedToGCalTs: '2026-07-01T00:00:00Z', lastSyncedFromGCalTs: '2026-08-09T00:00:00Z' }),
        ).toBe(false);
    });
});

describe('runMissedPushSweep — routine instances', () => {
    it('re-pushes a moved routine item edited after the routine last synced, patching by backfilled instance id', async () => {
        await seedCalendarIntegration();
        await routinesDAO.insertOne(linkedRoutine());
        await itemsDAO.insertOne(movedRoutineItem());
        const provider = fakeProvider();

        const result = await runMissedPushSweep({ userId, integrationId, before: dayjs().toISOString() }, () => provider as never);

        expect(result.repushedItems).toBe(1);
        expect(provider.updateRecurringInstance).toHaveBeenCalledTimes(1);
        const [call] = provider.updateRecurringInstance.mock.calls;
        if (!call) throw new Error('expected one updateRecurringInstance call');
        const [eventId, originalDate, patch, , , opts] = call;
        expect(eventId).toBe(masterEventId);
        expect(originalDate).toBe('2026-08-01');
        expect(patch).toMatchObject({ timeStart: '2026-08-16T04:00:00.000Z', timeEnd: '2026-08-16T04:15:00.000Z' });
        // 10:00 Asia/Jerusalem on 2026-08-01 (DST) = 07:00Z → the GCal instance-id suffix.
        expect(opts).toMatchObject({ instanceEventId: `${masterEventId}_20260801T070000Z` });

        // The computed instance id was persisted so future per-op pushes patch by id directly.
        const row = await itemsDAO.findByOwnerAndId('item-mps-moved', userId);
        expect(row?.calendarInstanceEventId).toBe(`${masterEventId}_20260801T070000Z`);
        // The push stamped the echo-detection anchor → the next sweep skips this item.
        expect(row?.lastPushedToGCalTs).toBeDefined();
    });

    it('skips a routine item written during the current sync run (updatedTs >= before fence)', async () => {
        await seedCalendarIntegration();
        await routinesDAO.insertOne(linkedRoutine());
        await itemsDAO.insertOne(movedRoutineItem());
        const provider = fakeProvider();

        // Fence pre-dates the item's updatedTs (2026-08-08T16:34) → the row counts as sync-written.
        const result = await runMissedPushSweep({ userId, integrationId, before: '2026-08-01T00:00:00.000Z' }, () => provider as never);

        expect(result.repushedItems).toBe(0);
        expect(provider.updateRecurringInstance).not.toHaveBeenCalled();
    });

    it('skips exception-referenced items in non-pushable statuses (trash is the cancellation path, not an override)', async () => {
        await seedCalendarIntegration();
        await routinesDAO.insertOne(linkedRoutine());
        await itemsDAO.insertOne(movedRoutineItem({ status: 'trash' }));
        const provider = fakeProvider();

        const result = await runMissedPushSweep({ userId, integrationId, before: dayjs().toISOString() }, () => provider as never);

        expect(result.repushedItems).toBe(0);
        expect(provider.updateRecurringInstance).not.toHaveBeenCalled();
        // Trash routes to cancellation, not override — assert that path stays silent too.
        expect(provider.cancelRecurringInstance).not.toHaveBeenCalled();
    });

    it('does NOT mirror an inbound-applied Google edit back out (updatedTs == lastSyncedFromGCalTs)', async () => {
        // Post-fix, the inbound exception apply stamps lastSyncedFromGCalTs to the same instant as
        // updatedTs — that item-level anchor must win over the routine's older fallback anchor.
        await seedCalendarIntegration();
        await routinesDAO.insertOne(linkedRoutine());
        await itemsDAO.insertOne(movedRoutineItem({ lastSyncedFromGCalTs: '2026-08-08T16:34:01.387Z' }));
        const provider = fakeProvider();

        const result = await runMissedPushSweep({ userId, integrationId, before: dayjs().toISOString() }, () => provider as never);

        expect(result.repushedItems).toBe(0);
        expect(provider.updateRecurringInstance).not.toHaveBeenCalled();
    });

    it('is idempotent — a second sweep after the push finds nothing to do', async () => {
        await seedCalendarIntegration();
        await routinesDAO.insertOne(linkedRoutine());
        await itemsDAO.insertOne(movedRoutineItem());
        const provider = fakeProvider();

        await runMissedPushSweep({ userId, integrationId, before: dayjs().toISOString() }, () => provider as never);
        const second = await runMissedPushSweep({ userId, integrationId, before: dayjs().toISOString() }, () => provider as never);

        expect(second.repushedItems).toBe(0);
        expect(provider.updateRecurringInstance).toHaveBeenCalledTimes(1);
    });

    it('skips an item whose lastPushedToGCalTs post-dates its updatedTs (already pushed)', async () => {
        await seedCalendarIntegration();
        await routinesDAO.insertOne(linkedRoutine());
        await itemsDAO.insertOne(movedRoutineItem({ lastPushedToGCalTs: '2026-08-08T17:00:00.000Z' }));
        const provider = fakeProvider();

        const result = await runMissedPushSweep({ userId, integrationId, before: dayjs().toISOString() }, () => provider as never);

        expect(result.repushedItems).toBe(0);
        expect(provider.updateRecurringInstance).not.toHaveBeenCalled();
    });

    it('skips routine items not referenced by any modified exception (unmodified instances mirror the master)', async () => {
        await seedCalendarIntegration();
        await routinesDAO.insertOne(linkedRoutine({ routineExceptions: [] }));
        await itemsDAO.insertOne(movedRoutineItem());
        const provider = fakeProvider();

        const result = await runMissedPushSweep({ userId, integrationId, before: dayjs().toISOString() }, () => provider as never);

        expect(result.repushedItems).toBe(0);
        expect(provider.updateRecurringInstance).not.toHaveBeenCalled();
    });

    it('skips disconnect-kept items awaiting relink (lastKnownCalendarEventId marker)', async () => {
        await seedCalendarIntegration();
        await routinesDAO.insertOne(linkedRoutine());
        await itemsDAO.insertOne(movedRoutineItem({ lastKnownCalendarEventId: masterEventId }));
        const provider = fakeProvider();

        const result = await runMissedPushSweep({ userId, integrationId, before: dayjs().toISOString() }, () => provider as never);

        expect(result.repushedItems).toBe(0);
        expect(provider.updateRecurringInstance).not.toHaveBeenCalled();
    });

    it('still pushes (via the date fallback) when another item already claims the computed instance id', async () => {
        await seedCalendarIntegration();
        await routinesDAO.insertOne(linkedRoutine());
        await itemsDAO.insertOne(movedRoutineItem());
        await itemsDAO.insertOne(
            movedRoutineItem({ _id: 'item-mps-claimer', routineId: undefined, calendarInstanceEventId: `${masterEventId}_20260801T070000Z` }),
        );
        const provider = fakeProvider();

        const result = await runMissedPushSweep({ userId, integrationId, before: dayjs().toISOString() }, () => provider as never);

        expect(result.repushedItems).toBe(1);
        expect(provider.updateRecurringInstance).toHaveBeenCalledTimes(1);
        const [call] = provider.updateRecurringInstance.mock.calls;
        if (!call) throw new Error('expected one updateRecurringInstance call');
        expect(call[5]?.instanceEventId).toBeUndefined();
        const row = await itemsDAO.findByOwnerAndId('item-mps-moved', userId);
        expect(row?.calendarInstanceEventId).toBeUndefined();
    });
});

describe('runMissedPushSweep — standalone linked items', () => {
    function standaloneItem(overrides: Partial<ItemInterface> = {}): ItemInterface {
        return {
            _id: 'item-mps-standalone',
            user: userId,
            status: 'calendar',
            title: 'Dentist',
            timeStart: '2026-08-20T08:00:00.000Z',
            timeEnd: '2026-08-20T09:00:00.000Z',
            calendarEventId: 'gcal-evt-standalone',
            calendarIntegrationId: integrationId,
            calendarSyncConfigId: configId,
            lastPushedToGCalTs: '2026-08-01T00:00:00.000Z',
            createdTs: '2026-07-01T00:00:00.000Z',
            updatedTs: '2026-08-08T16:00:00.000Z',
            ...overrides,
        };
    }

    it('re-pushes a linked item whose updatedTs post-dates its push anchor', async () => {
        await seedCalendarIntegration();
        await itemsDAO.insertOne(standaloneItem());
        const provider = fakeProvider();

        const result = await runMissedPushSweep({ userId, integrationId, before: dayjs().toISOString() }, () => provider as never);

        expect(result.repushedItems).toBe(1);
        expect(provider.updateEvent).toHaveBeenCalledTimes(1);
    });

    it('skips an anchor-less linked item — no evidence which side is newer', async () => {
        await seedCalendarIntegration();
        await itemsDAO.insertOne(standaloneItem({ lastPushedToGCalTs: undefined }));
        const provider = fakeProvider();

        const result = await runMissedPushSweep({ userId, integrationId, before: dayjs().toISOString() }, () => provider as never);

        expect(result.repushedItems).toBe(0);
        expect(provider.updateEvent).not.toHaveBeenCalled();
    });

    it('scopes to the given integration — items of another integration are untouched', async () => {
        await seedCalendarIntegration();
        await itemsDAO.insertOne(standaloneItem({ calendarIntegrationId: 'integ-other' }));
        const provider = fakeProvider();

        const result = await runMissedPushSweep({ userId, integrationId, before: dayjs().toISOString() }, () => provider as never);

        expect(result.repushedItems).toBe(0);
        expect(provider.updateEvent).not.toHaveBeenCalled();
    });

    it('skips rows written during the current sync run (updatedTs >= before fence)', async () => {
        // The relink sweep / inbound apply rewrite items mid-sync with a fresh updatedTs and an
        // older lastSyncedFromGCalTs — without the fence the sweep would push GCal's own state back.
        await seedCalendarIntegration();
        await itemsDAO.insertOne(standaloneItem());
        const provider = fakeProvider();

        const result = await runMissedPushSweep({ userId, integrationId, before: '2026-08-08T00:00:00.000Z' }, () => provider as never);

        expect(result.repushedItems).toBe(0);
        expect(provider.updateEvent).not.toHaveBeenCalled();
    });

    it('one failing push does not abort the sweep', async () => {
        await seedCalendarIntegration();
        await itemsDAO.insertOne(standaloneItem());
        await itemsDAO.insertOne(standaloneItem({ _id: 'item-mps-standalone-2', calendarEventId: 'gcal-evt-standalone-2' }));
        const provider = fakeProvider();
        provider.updateEvent.mockRejectedValueOnce(new Error('gcal 500'));

        const result = await runMissedPushSweep({ userId, integrationId, before: dayjs().toISOString() }, () => provider as never);

        expect(result.repushedItems).toBe(1);
        expect(provider.updateEvent).toHaveBeenCalledTimes(2);
    });
});

describe('inbound exception apply stamps the item-level anchor', () => {
    // These pin the invariant the sweep depends on: every Google-originated item write carries
    // lastSyncedFromGCalTs == updatedTs, so isMissedPush() classifies it as "not locally newer".
    const instanceEventId = `${masterEventId}_20260801T070000Z`;

    it('applyModifiedExceptionToOne stamps lastSyncedFromGCalTs alongside updatedTs', async () => {
        await seedCalendarIntegration();
        await routinesDAO.insertOne(linkedRoutine({ routineExceptions: [] }));
        await itemsDAO.insertOne(movedRoutineItem({ calendarInstanceEventId: instanceEventId }));
        const now = dayjs().toISOString();
        const movedStart = dayjs().add(30, 'day').format('YYYY-MM-DDTHH:mm:ss');
        const movedEnd = dayjs().add(30, 'day').add(15, 'minute').format('YYYY-MM-DDTHH:mm:ss');

        const ctx: Parameters<typeof applyExceptionToItems>[2] = { userId, now, ops: [] };
        const routine = await routinesDAO.findByOwnerAndId('routine-mps-1', userId);
        if (!routine) throw new Error('expected seeded routine');
        await applyExceptionToItems(
            routine,
            { originalDate: '2026-08-01', type: 'modified', googleEventId: instanceEventId, newTimeStart: movedStart, newTimeEnd: movedEnd },
            ctx,
        );

        const row = await itemsDAO.findByOwnerAndId('item-mps-moved', userId);
        expect(row?.lastSyncedFromGCalTs).toBe(now);
        expect(row?.updatedTs).toBe(now);
        // The freshly-applied Google edit must not qualify for a re-push.
        expect(isMissedPush({ updatedTs: row?.updatedTs ?? '', lastSyncedFromGCalTs: row?.lastSyncedFromGCalTs })).toBe(false);
    });

    it('createItemForOrphanedException stamps lastSyncedFromGCalTs on the created row', async () => {
        await seedCalendarIntegration();
        await routinesDAO.insertOne(linkedRoutine({ routineExceptions: [] }));
        const now = dayjs().toISOString();
        const movedStart = dayjs().add(45, 'day').format('YYYY-MM-DDTHH:mm:ss');
        const movedEnd = dayjs().add(45, 'day').add(15, 'minute').format('YYYY-MM-DDTHH:mm:ss');

        const ctx: Parameters<typeof applyExceptionToItems>[2] = { userId, now, ops: [] };
        const routine = await routinesDAO.findByOwnerAndId('routine-mps-1', userId);
        if (!routine) throw new Error('expected seeded routine');
        await applyExceptionToItems(
            routine,
            {
                originalDate: '2026-11-01',
                type: 'modified',
                googleEventId: `${masterEventId}_20261101T080000Z`,
                newTimeStart: movedStart,
                newTimeEnd: movedEnd,
            },
            ctx,
        );

        const rows = await itemsDAO.findArray({ user: userId, routineId: 'routine-mps-1' });
        expect(rows).toHaveLength(1);
        const [created] = rows;
        if (!created) throw new Error('expected one orphan-created item');
        expect(created.lastSyncedFromGCalTs).toBe(now);
        expect(isMissedPush({ updatedTs: created.updatedTs, lastSyncedFromGCalTs: created.lastSyncedFromGCalTs })).toBe(false);
    });
});
