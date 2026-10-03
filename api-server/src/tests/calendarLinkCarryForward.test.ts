/**
 * Regression tests for the 2026-09-27 production incident: completing (or editing) a calendar
 * item before the client pulled the Google link the server stamped after `events.insert` erased
 * `calendarEventId` & co. on apply (whole-snapshot `replaceById`), so the done op matched no
 * pushback branch — no ✓ marker on Google, no SyncIssues row, an orphaned event for good. The fix
 * carries the stored row's server-owned calendar fields into the incoming snapshot before apply
 * (`hydrateCalendarLinkCarryForward`), so the row, the op log and the pushback all see the link.
 */
import dayjs from 'dayjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import { applyAndPublishOperation, applyAndPublishOperations } from '../lib/applyOperation.js';
import { CALENDAR_LINK_FIELDS, CALENDAR_SYNC_ANCHOR_FIELDS, carryForwardCalendarLink } from '../lib/calendarLinkCarryForward.js';
import { gcalCreationInFlight, maybePushToGCal } from '../lib/calendarPushback.js';
import { DONE_COLOR_ID } from '../lib/doneMarker.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import type { CalendarIntegrationInterface, CalendarSyncConfigInterface, ItemInterface, OperationInterface } from '../types/entities.js';

beforeAll(async () => {
    await loadDataAccess('gtd_test');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([
        db.collection('items').deleteMany({}),
        db.collection('operations').deleteMany({}),
        db.collection('calendarIntegrations').deleteMany({}),
        db.collection('calendarSyncConfigs').deleteMany({}),
    ]);
    vi.restoreAllMocks();
    gcalCreationInFlight.clear();
});

const userId = 'user-link-carry-forward';
const integrationId = 'integ-lcf-1';
const configId = 'config-lcf-1';
const itemId = 'item-lcf-1';
const T0 = '2026-09-27T10:00:00.000Z';
const T1 = '2026-09-27T10:00:30.000Z';

/**
 * The client's edit clock in the pipeline tests: strictly after the link stamp (which is server
 * `now` at push time), as in the real race. One second ahead so it beats the stamp even when both
 * land in the same millisecond; the apply pipeline future-clamps it to its own `now`, which is
 * still at or after the stamp — so the op wins last-write-wins and the assertions discriminate.
 */
const afterLinkStamp = () => dayjs().add(1, 'second').toISOString();

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

/** What the client sends: the item as IT knows it — never the server-stamped link fields. */
function clientSnapshot(overrides: Partial<ItemInterface> = {}): ItemInterface {
    return {
        _id: itemId,
        user: userId,
        status: 'calendar',
        title: 'Demo: sync to Google Calendar',
        timeStart: '2026-09-28T10:00:00Z',
        timeEnd: '2026-09-28T11:00:00Z',
        createdTs: T0,
        updatedTs: T0,
        ...overrides,
    };
}

interface FakeGoogle {
    createEvent: ReturnType<typeof vi.fn>;
    updateEvent: ReturnType<typeof vi.fn>;
    deleteEvent: ReturnType<typeof vi.fn>;
}

// The CalendarProvider interface has many methods; the paths under test touch three. Call sites
// assert on the spies, not on type-level completeness.
function fakeGoogle(): FakeGoogle & { factory: () => never } {
    const spies = {
        createEvent: vi.fn().mockResolvedValue({ eventId: 'gtd-evt-lcf', htmlLink: 'https://calendar.google.com/event?eid=lcf' }),
        updateEvent: vi.fn().mockResolvedValue(undefined),
        deleteEvent: vi.fn().mockResolvedValue(undefined),
    };
    return { ...spies, factory: () => ({ ...spies, getCalendarTimeZone: vi.fn().mockResolvedValue('UTC') }) as never };
}

/** Client creates the item; pushback creates the Google event and stamps the link (updatedTs = server now > T0). */
async function createAndLink(google: FakeGoogle & { factory: () => never }): Promise<OperationInterface[]> {
    const createOp = await applyAndPublishOperation(
        userId,
        { entityType: 'item', opType: 'create', entityId: itemId, snapshot: clientSnapshot() },
        { deviceId: 'device-lcf', suppressGCalPushback: true },
    );
    const recorded = await maybePushToGCal(createOp, google.factory);
    const linked = await itemsDAO.findByOwnerAndId(itemId, userId);
    expect(linked?.calendarEventId).toBe('gtd-evt-lcf');
    return recorded;
}

function expectLinkIntact(row: ItemInterface | null) {
    expect(row?.calendarEventId).toBe('gtd-evt-lcf');
    expect(row?.calendarIntegrationId).toBe(integrationId);
    expect(row?.calendarSyncConfigId).toBe(configId);
    expect(row?.htmlLink).toBe('https://calendar.google.com/event?eid=lcf');
    expect(row?.lastPushedToGCalTs).toBeTruthy();
}

describe('carryForwardCalendarLink (pure)', () => {
    const existing = clientSnapshot({
        calendarEventId: 'evt-1',
        calendarIntegrationId: integrationId,
        calendarSyncConfigId: configId,
        htmlLink: 'https://g/evt-1',
        lastPushedToGCalTs: T0,
        lastSyncedNotes: '<p>x</p>',
        lastSyncedFromGCalTs: T0,
        calendarInstanceEventId: 'master_20260928T100000Z',
    });

    it('fills every absent server-owned field on a done snapshot and leaves the client fields alone', () => {
        const merged = carryForwardCalendarLink(existing, clientSnapshot({ status: 'done', title: 'edited', updatedTs: T1 }));
        expect(merged).toMatchObject({
            status: 'done',
            title: 'edited',
            updatedTs: T1,
            calendarEventId: 'evt-1',
            calendarIntegrationId: integrationId,
            calendarSyncConfigId: configId,
            htmlLink: 'https://g/evt-1',
            lastPushedToGCalTs: T0,
            lastSyncedNotes: '<p>x</p>',
            lastSyncedFromGCalTs: T0,
            calendarInstanceEventId: 'master_20260928T100000Z',
        });
    });

    it('carries into trash too (trash rows keep the link so a revive can relink)', () => {
        expect(carryForwardCalendarLink(existing, clientSnapshot({ status: 'trash', updatedTs: T1 })).calendarEventId).toBe('evt-1');
    });

    it.each([
        'inbox',
        'nextAction',
        'waitingFor',
        'somedayMaybe',
    ] as const)('never carries into a detach status (%s) — the client stripped the link on purpose', (status) => {
        const merged = carryForwardCalendarLink(existing, clientSnapshot({ status, updatedTs: T1 }));
        expect(merged.calendarEventId).toBeUndefined();
        expect(merged.lastPushedToGCalTs).toBeUndefined();
    });

    it('does not overwrite a field the snapshot already carries', () => {
        const merged = carryForwardCalendarLink(existing, clientSnapshot({ calendarEventId: 'evt-1', htmlLink: 'https://g/client-copy', updatedTs: T1 }));
        expect(merged.htmlLink).toBe('https://g/client-copy');
        expect(merged.calendarIntegrationId).toBe(integrationId);
    });

    it('carries nothing onto a snapshot that names a DIFFERENT integration (re-targeted item) — link and anchors all describe the old event', () => {
        const incoming = clientSnapshot({ calendarIntegrationId: 'integ-other', updatedTs: T1 });
        expect(carryForwardCalendarLink(existing, incoming)).toEqual(incoming);
    });

    it('carries nothing onto a snapshot that names a DIFFERENT event', () => {
        const incoming = clientSnapshot({ calendarEventId: 'evt-2', updatedTs: T1 });
        expect(carryForwardCalendarLink(existing, incoming)).toEqual(incoming);
    });

    it('carries the anchors of a routine occurrence (no event id on either side)', () => {
        const occurrence = clientSnapshot({ routineId: 'r-1', calendarInstanceEventId: 'master_20260928T100000Z', lastSyncedFromGCalTs: T0 });
        const merged = carryForwardCalendarLink(occurrence, clientSnapshot({ status: 'done', routineId: 'r-1', updatedTs: T1 }));
        expect(merged.calendarInstanceEventId).toBe('master_20260928T100000Z');
        expect(merged.lastSyncedFromGCalTs).toBe(T0);
        expect(merged.calendarEventId).toBeUndefined();
    });

    it('parity pin — the SAME literals live in client/src/tests/calendarLinkMerge.test.ts; change both together', () => {
        expect(CALENDAR_LINK_FIELDS).toEqual(['calendarEventId', 'calendarIntegrationId', 'calendarSyncConfigId', 'htmlLink']);
        expect(CALENDAR_SYNC_ANCHOR_FIELDS).toEqual(['calendarInstanceEventId', 'lastPushedToGCalTs', 'lastSyncedNotes', 'lastSyncedFromGCalTs']);
    });

    it('is a no-op when the stored row has nothing server-owned', () => {
        const incoming = clientSnapshot({ status: 'done', updatedTs: T1 });
        expect(carryForwardCalendarLink(clientSnapshot(), incoming)).toEqual(incoming);
    });
});

describe('create in flight — the op lands before the link stamp (nothing could push it yet)', () => {
    /** Client creates; BEFORE pushback has created the Google event, a second client op applies. */
    async function createThenApplyBeforePush(second: Partial<ItemInterface>) {
        const createOp = await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'create', entityId: itemId, snapshot: clientSnapshot() },
            { deviceId: 'device-lcf', suppressGCalPushback: true },
        );
        await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'update', entityId: itemId, snapshot: clientSnapshot({ ...second, updatedTs: afterLinkStamp() }) },
            { deviceId: 'device-lcf', suppressGCalPushback: true },
        );
        return createOp;
    }

    it('done during the create: the event is created, then marked ✓ from the row’s current state; the stamp op carries done + link', async () => {
        await seedCalendarIntegration();
        const google = fakeGoogle();
        const createOp = await createThenApplyBeforePush({ status: 'done' });

        const recorded = await maybePushToGCal(createOp, google.factory);

        expect(google.createEvent).toHaveBeenCalledTimes(1);
        expect(google.updateEvent).toHaveBeenCalledTimes(1);
        const [, eventId, patch] = google.updateEvent.mock.calls[0] as [string, string, { title: string; colorId: string }];
        expect(eventId).toBe('gtd-evt-lcf');
        expect(patch.title).toBe('✓ Demo: sync to Google Calendar');
        expect(patch.colorId).toBe(DONE_COLOR_ID);
        const row = await itemsDAO.findByOwnerAndId(itemId, userId);
        expect(row?.status).toBe('done');
        expectLinkIntact(row);
        expect(recorded.map((op) => (op.snapshot as ItemInterface).status)).toEqual(['done']);
    });

    it('edit during the create: the event is updated to the edited title instead of staying at the create-time state', async () => {
        await seedCalendarIntegration();
        const google = fakeGoogle();
        const createOp = await createThenApplyBeforePush({ title: 'Demo (renamed mid-flight)' });

        await maybePushToGCal(createOp, google.factory);

        expect(google.updateEvent).toHaveBeenCalledTimes(1);
        expect((google.updateEvent.mock.calls[0] as [string, string, { title: string }])[2].title).toBe('Demo (renamed mid-flight)');
    });

    it('trash during the create: the just-created event is deleted', async () => {
        await seedCalendarIntegration();
        const google = fakeGoogle();
        const createOp = await createThenApplyBeforePush({ status: 'trash' });

        await maybePushToGCal(createOp, google.factory);

        expect(google.deleteEvent).toHaveBeenCalledWith('cal-1', 'gtd-evt-lcf');
        const row = await itemsDAO.findByOwnerAndId(itemId, userId);
        expect(row?.status).toBe('trash');
        // Trash rows keep the link (a revive relinks) — only the detach path clears it.
        expect(row?.calendarEventId).toBe('gtd-evt-lcf');
    });

    it('detach during the create: the just-created event is deleted again and the link comes off the non-calendar row', async () => {
        await seedCalendarIntegration();
        const google = fakeGoogle();
        const createOp = await createThenApplyBeforePush({ status: 'nextAction', timeStart: undefined, timeEnd: undefined });

        const recorded = await maybePushToGCal(createOp, google.factory);

        expect(google.deleteEvent).toHaveBeenCalledWith('cal-1', 'gtd-evt-lcf');
        const row = await itemsDAO.findByOwnerAndId(itemId, userId);
        expect(row?.status).toBe('nextAction');
        expect(row?.calendarEventId).toBeUndefined();
        expect(row?.calendarIntegrationId).toBeUndefined();
        // Stamp op (linked) then unlink op — devices replay both and converge on the unlinked row.
        expect(recorded.map((op) => (op.snapshot as ItemInterface).calendarEventId)).toEqual(['gtd-evt-lcf', undefined]);
    });

    it('a failed follow-up surfaces on the create op, and re-firing it (Retry) completes the ✓ through the already-linked branch', async () => {
        await seedCalendarIntegration();
        const google = fakeGoogle();
        google.updateEvent.mockRejectedValueOnce(Object.assign(new Error('Rate Limit Exceeded'), { code: 403 }));
        const createOp = await createThenApplyBeforePush({ status: 'done' });

        await maybePushToGCal(createOp, google.factory);
        const failedOp = await operationsDAO.findOne({ _id: createOp._id });
        expect(failedOp?.syncFailed).toBe(true);
        expect((await itemsDAO.findByOwnerAndId(itemId, userId))?.calendarEventId).toBe('gtd-evt-lcf');

        await maybePushToGCal(createOp, google.factory);
        expect(google.createEvent).toHaveBeenCalledTimes(1);
        expect(google.updateEvent).toHaveBeenCalledTimes(2);
        expect((google.updateEvent.mock.calls[1] as [string, string, { title: string }])[2].title).toBe('✓ Demo: sync to Google Calendar');
    });

    it('an unchanged row after the create needs no follow-up', async () => {
        await seedCalendarIntegration();
        const google = fakeGoogle();
        await createAndLink(google);
        expect(google.updateEvent).not.toHaveBeenCalled();
    });
});

describe('apply pipeline — the incident: done before the link round-tripped', () => {
    it('keeps the link on the row and in the op log, and pushback marks the Google event ✓ instead of silently dropping', async () => {
        await seedCalendarIntegration();
        const google = fakeGoogle();
        await createAndLink(google);

        // ~30 s later the client marks it done. Its snapshot never learned the link.
        const doneOp = await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'update', entityId: itemId, snapshot: clientSnapshot({ status: 'done', updatedTs: afterLinkStamp() }) },
            { deviceId: 'device-lcf', suppressGCalPushback: true },
        );

        const row = await itemsDAO.findByOwnerAndId(itemId, userId);
        expectLinkIntact(row);
        expect(row?.status).toBe('done');
        // The persisted op (what every device — the originating one included — pulls) carries the link.
        const persisted = await operationsDAO.findOne({ _id: doneOp._id });
        expectLinkIntact(persisted?.snapshot as ItemInterface);

        await maybePushToGCal(doneOp, google.factory);
        expect(google.createEvent).toHaveBeenCalledTimes(1); // only the original create
        expect(google.updateEvent).toHaveBeenCalledTimes(1);
        const [calendarId, eventId, patch] = google.updateEvent.mock.calls[0] as [string, string, { title: string; colorId: string }];
        expect(calendarId).toBe('cal-1');
        expect(eventId).toBe('gtd-evt-lcf');
        expect(patch.title).toBe('✓ Demo: sync to Google Calendar');
        expect(patch.colorId).toBe(DONE_COLOR_ID);
    });

    it('the worse variant: an edit inside the window updates the existing event instead of creating a duplicate', async () => {
        await seedCalendarIntegration();
        const google = fakeGoogle();
        await createAndLink(google);

        const editOp = await applyAndPublishOperation(
            userId,
            {
                entityType: 'item',
                opType: 'update',
                entityId: itemId,
                snapshot: clientSnapshot({ title: 'Demo (moved)', timeStart: '2026-09-28T11:00:00Z', updatedTs: afterLinkStamp() }),
            },
            { deviceId: 'device-lcf', suppressGCalPushback: true },
        );
        const row = await itemsDAO.findByOwnerAndId(itemId, userId);
        expectLinkIntact(row);
        expect(row?.title).toBe('Demo (moved)');

        await maybePushToGCal(editOp, google.factory);
        expect(google.createEvent).toHaveBeenCalledTimes(1);
        expect(google.updateEvent).toHaveBeenCalledTimes(1);
        expect(google.updateEvent.mock.calls[0]?.[1]).toBe('gtd-evt-lcf');
    });

    it('trash inside the window deletes the Google event', async () => {
        await seedCalendarIntegration();
        const google = fakeGoogle();
        await createAndLink(google);

        const trashOp = await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'update', entityId: itemId, snapshot: clientSnapshot({ status: 'trash', updatedTs: afterLinkStamp() }) },
            { deviceId: 'device-lcf', suppressGCalPushback: true },
        );
        const row = await itemsDAO.findByOwnerAndId(itemId, userId);
        expect(row?.status).toBe('trash');
        expect(row?.calendarEventId).toBe('gtd-evt-lcf');
        await maybePushToGCal(trashOp, google.factory);
        expect(google.deleteEvent).toHaveBeenCalledWith('cal-1', 'gtd-evt-lcf');
    });

    it('a detach inside the window still drops the link and removes the event (existing cascade keeps precedence)', async () => {
        await seedCalendarIntegration();
        const google = fakeGoogle();
        await createAndLink(google);

        const detachOp = await applyAndPublishOperation(
            userId,
            {
                entityType: 'item',
                opType: 'update',
                entityId: itemId,
                snapshot: clientSnapshot({ status: 'nextAction', timeStart: undefined, timeEnd: undefined, updatedTs: afterLinkStamp() }),
            },
            { deviceId: 'device-lcf', suppressGCalPushback: true },
        );
        const row = await itemsDAO.findByOwnerAndId(itemId, userId);
        expect(row?.status).toBe('nextAction');
        expect(row?.calendarEventId).toBeUndefined();
        expect(detachOp.detachedCalendar?.calendarEventId).toBe('gtd-evt-lcf');
        await maybePushToGCal(detachOp, google.factory);
        expect(google.deleteEvent).toHaveBeenCalledWith('cal-1', 'gtd-evt-lcf');
    });

    it('a stale snapshot (older than the link stamp) still loses last-write-wins — the row keeps the link untouched', async () => {
        await seedCalendarIntegration();
        const google = fakeGoogle();
        await createAndLink(google);
        const before = await itemsDAO.findByOwnerAndId(itemId, userId);

        await applyAndPublishOperation(
            userId,
            {
                entityType: 'item',
                opType: 'update',
                entityId: itemId,
                snapshot: clientSnapshot({ title: 'from the past', updatedTs: '2026-09-27T09:00:00.000Z' }),
            },
            { deviceId: 'device-lcf', suppressGCalPushback: true },
        );
        expect(await itemsDAO.findByOwnerAndId(itemId, userId)).toEqual(before);
    });

    it('batch path (/sync/push) carries the link forward too', async () => {
        await seedCalendarIntegration();
        const google = fakeGoogle();
        await createAndLink(google);

        const { ops } = await applyAndPublishOperations(
            userId,
            [{ entityType: 'item', opType: 'update', entityId: itemId, snapshot: clientSnapshot({ status: 'done', updatedTs: afterLinkStamp() }) }],
            { deviceId: 'device-lcf', suppressGCalPushback: true },
        );
        const row = await itemsDAO.findByOwnerAndId(itemId, userId);
        expectLinkIntact(row);
        expect(row?.status).toBe('done');
        expectLinkIntact(ops[0]?.snapshot as ItemInterface);
    });

    it('carries a routine item’s server-backfilled calendarInstanceEventId through a client done op', async () => {
        await itemsDAO.insertOne(clientSnapshot({ routineId: 'routine-lcf', calendarInstanceEventId: 'master_20260928T100000Z', lastSyncedFromGCalTs: T0 }));
        const doneOp = await applyAndPublishOperation(
            userId,
            {
                entityType: 'item',
                opType: 'update',
                entityId: itemId,
                snapshot: clientSnapshot({ status: 'done', routineId: 'routine-lcf', updatedTs: afterLinkStamp() }),
            },
            { deviceId: 'device-lcf', suppressGCalPushback: true },
        );
        const row = await itemsDAO.findByOwnerAndId(itemId, userId);
        expect(row?.calendarInstanceEventId).toBe('master_20260928T100000Z');
        expect(row?.lastSyncedFromGCalTs).toBe(T0);
        expect((doneOp.snapshot as ItemInterface).calendarInstanceEventId).toBe('master_20260928T100000Z');
    });

    it('a server path that drops a server-owned field on purpose opts out with skipCalendarLinkCarryForward', async () => {
        // The routine pause frees `calendarInstanceEventId` on the items it trashes (unique-index slot
        // release) by omitting it from server-built snapshots. Without the opt-out the hydrator would
        // read that omission as "client never saw it" and restore the id.
        await itemsDAO.insertOne(clientSnapshot({ routineId: 'routine-lcf', calendarInstanceEventId: 'master_20260928T100000Z' }));
        const freedSnapshot = clientSnapshot({ status: 'trash', routineId: 'routine-lcf', updatedTs: afterLinkStamp() });

        await applyAndPublishOperations(userId, [{ entityType: 'item', opType: 'update', entityId: itemId, snapshot: freedSnapshot }], {
            deviceId: 'api:tok-pause',
            suppressGCalPushback: true,
            skipCalendarLinkCarryForward: true,
        });
        expect((await itemsDAO.findByOwnerAndId(itemId, userId))?.calendarInstanceEventId).toBeUndefined();

        // Control: the same snapshot from a client (no opt-out) keeps the id.
        await itemsDAO.updateOne({ _id: itemId, user: userId }, { $set: { calendarInstanceEventId: 'master_20260928T100000Z' } });
        await applyAndPublishOperations(
            userId,
            [{ entityType: 'item', opType: 'update', entityId: itemId, snapshot: { ...freedSnapshot, updatedTs: afterLinkStamp() } }],
            {
                deviceId: 'device-lcf',
                suppressGCalPushback: true,
            },
        );
        expect((await itemsDAO.findByOwnerAndId(itemId, userId))?.calendarInstanceEventId).toBe('master_20260928T100000Z');
    });

    it('maybePushToGCal resolves to the link-stamp op after a create, and to nothing for a plain update', async () => {
        await seedCalendarIntegration();
        const google = fakeGoogle();
        const recorded = await createAndLink(google);
        expect(recorded).toHaveLength(1);
        const [linkOp] = recorded;
        if (!linkOp) throw new Error('expected the link-stamp op');
        expect(linkOp.deviceId).toBe('server');
        expect((linkOp.snapshot as ItemInterface).calendarEventId).toBe('gtd-evt-lcf');

        const doneOp = await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'update', entityId: itemId, snapshot: clientSnapshot({ status: 'done', updatedTs: afterLinkStamp() }) },
            { deviceId: 'device-lcf', suppressGCalPushback: true },
        );
        expect(await maybePushToGCal(doneOp, google.factory)).toEqual([]);
    });
});
