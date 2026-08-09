/** biome-ignore-all lint/style/noNonNullAssertion: test code asserts result before using ! */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import { applyAndPublishOperation, applyAndPublishOperations, OperationValidationError } from '../lib/applyOperation.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import type { ItemInterface, RoutineInterface } from '../types/entities.js';

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
        db.collection('webhookSubscriptions').deleteMany({}),
        db.collection('webhookDeliveries').deleteMany({}),
    ]);
    vi.restoreAllMocks();
});

const userId = 'user-apply-test';

const baseInboxItem = (overrides: Partial<ItemInterface> = {}): ItemInterface => ({
    _id: 'item-1',
    user: userId,
    status: 'inbox',
    title: 'buy milk',
    createdTs: '2026-05-08T10:00:00Z',
    updatedTs: '2026-05-08T10:00:00Z',
    ...overrides,
});

describe('applyAndPublishOperation — happy path', () => {
    it('persists a new item, logs the op, and tags deviceId', async () => {
        const op = await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'create', entityId: 'item-1', snapshot: baseInboxItem() },
            { deviceId: 'api:tok-1' },
        );

        expect(op._id).toBeTruthy();
        expect(op.deviceId).toBe('api:tok-1');
        expect(op.user).toBe(userId);

        const stored = await itemsDAO.findByOwnerAndId('item-1', userId);
        expect(stored?.title).toBe('buy milk');

        const ops = await operationsDAO.findArray({ user: userId });
        expect(ops).toHaveLength(1);
        expect(ops[0]!._id).toBe(op._id);
    });

    it('overwrites server-authoritative user from snapshot', async () => {
        await applyAndPublishOperation(
            userId,
            {
                entityType: 'item',
                opType: 'create',
                entityId: 'item-1',
                snapshot: { ...baseInboxItem(), user: 'evil-other-user' },
            },
            { deviceId: 'device-abc' },
        );

        const stored = await itemsDAO.findByOwnerAndId('item-1', userId);
        expect(stored?.user).toBe(userId);
    });

    it('handles item.delete with snapshot=null and hydrates from the pre-delete row', async () => {
        await itemsDAO.insertOne(baseInboxItem());
        const op = await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'delete', entityId: 'item-1', snapshot: null },
            { deviceId: 'device-abc' },
        );

        // The wire op carried snapshot:null; the pipeline hydrates it so downstream fan-out
        // (GCal pushback, reference cascades) has the pre-delete state.
        expect(op.snapshot).toMatchObject({ _id: 'item-1', title: 'buy milk' });
        const stored = await itemsDAO.findByOwnerAndId('item-1', userId);
        expect(stored).toBeNull();
    });
});

describe('applyAndPublishOperation — updatedTs clamping', () => {
    it('clamps a future updatedTs to server time in both the collection row and the op log', async () => {
        const now = '2026-05-08T12:00:00.000Z';
        // A fast device clock (or an MCP caller deriving timestamps from a local date) stamps the
        // future; unclamped, every later legitimate edit would lose LWW to this snapshot.
        const poisoned = baseInboxItem({ updatedTs: '2026-05-09T23:00:00.000Z' });

        const op = await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'create', entityId: 'item-1', snapshot: poisoned },
            { deviceId: 'api:tok-1', now },
        );

        expect((op.snapshot as ItemInterface).updatedTs).toBe(now);
        const stored = await itemsDAO.findByOwnerAndId('item-1', userId);
        expect(stored?.updatedTs).toBe(now);

        // The poison scenario end-to-end: a later legitimate edit must now win LWW.
        const laterEdit = baseInboxItem({ title: 'buy oat milk', updatedTs: '2026-05-08T12:30:00.000Z' });
        await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'update', entityId: 'item-1', snapshot: laterEdit },
            { deviceId: 'api:tok-1', now: '2026-05-08T12:30:00.000Z' },
        );
        expect((await itemsDAO.findByOwnerAndId('item-1', userId))?.title).toBe('buy oat milk');
    });

    it('leaves updatedTs === now untouched and does not warn (clamp is strictly future-side)', async () => {
        const now = '2026-05-08T12:00:00.000Z';
        const warn = vi.spyOn(console, 'warn');

        const op = await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'create', entityId: 'item-1', snapshot: baseInboxItem({ updatedTs: now }) },
            { deviceId: 'api:tok-1', now },
        );

        expect((op.snapshot as ItemInterface).updatedTs).toBe(now);
        expect(warn.mock.calls.filter(([msg]) => typeof msg === 'string' && msg.includes('clamping future updatedTs'))).toHaveLength(0);
    });

    it('keeps the calendar-detach gate consistent with the apply gate for a clamped stale op', async () => {
        // The detach hydrator and the LWW apply both compare existing.updatedTs against the
        // incoming snapshot. Clamping can flip the incoming below an existing future-stamped row;
        // both gates must then skip TOGETHER — detaching the GCal event of a row that stays in
        // place would strand a live calendar item with its event deleted.
        const now = '2026-05-08T12:00:00.000Z';
        const existing = baseInboxItem({
            status: 'calendar',
            timeStart: '2026-05-10T09:00:00+03:00',
            timeEnd: '2026-05-10T09:30:00+03:00',
            calendarEventId: 'evt-detach-clamp',
            calendarIntegrationId: 'int-1',
            updatedTs: '2026-05-08T13:00:00.000Z',
        });
        await itemsDAO.insertOne(existing);

        const staleClarify = baseInboxItem({ status: 'nextAction', updatedTs: '2026-05-09T00:00:00.000Z' });
        const op = await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'update', entityId: 'item-1', snapshot: staleClarify },
            { deviceId: 'api:tok-1', now },
        );

        const stored = await itemsDAO.findByOwnerAndId('item-1', userId);
        expect(stored?.status).toBe('calendar');
        expect(op.detachedCalendar).toBeUndefined();
    });

    it('leaves a past updatedTs untouched — offline history must keep losing LWW to newer edits', async () => {
        const now = '2026-05-08T12:00:00.000Z';
        const offlineEdit = baseInboxItem({ updatedTs: '2026-05-01T09:00:00.000Z' });

        const op = await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'create', entityId: 'item-1', snapshot: offlineEdit },
            { deviceId: 'api:tok-1', now },
        );

        expect((op.snapshot as ItemInterface).updatedTs).toBe('2026-05-01T09:00:00.000Z');
    });

    it('clamps future updatedTs in the batch path too', async () => {
        const now = '2026-05-08T12:00:00.000Z';
        const ops = await applyAndPublishOperations(
            userId,
            [
                { entityType: 'item', opType: 'create', entityId: 'item-1', snapshot: baseInboxItem({ updatedTs: '2027-01-01T00:00:00.000Z' }) },
                { entityType: 'item', opType: 'create', entityId: 'item-2', snapshot: baseInboxItem({ _id: 'item-2', updatedTs: '2026-05-08T11:00:00.000Z' }) },
            ],
            { deviceId: 'dev-1', now },
        );

        expect((ops[0]!.snapshot as ItemInterface).updatedTs).toBe(now);
        // The non-poisoned sibling keeps its own timestamp.
        expect((ops[1]!.snapshot as ItemInterface).updatedTs).toBe('2026-05-08T11:00:00.000Z');
        expect((await itemsDAO.findByOwnerAndId('item-1', userId))?.updatedTs).toBe(now);
    });
});

describe('applyAndPublishOperation — strict-mode validation', () => {
    it('throws OperationValidationError for ignoreBefore on calendar item', async () => {
        const snapshot = baseInboxItem({
            status: 'calendar',
            timeStart: '2026-05-09T10:00:00Z',
            timeEnd: '2026-05-09T11:00:00Z',
            ignoreBefore: '2026-05-08',
        });
        await expect(
            applyAndPublishOperation(userId, { entityType: 'item', opType: 'create', entityId: 'item-1', snapshot }, { deviceId: 'api:tok-1', strict: true }),
        ).rejects.toBeInstanceOf(OperationValidationError);
    });

    it('does NOT throw in permissive mode but logs', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const snapshot = baseInboxItem({
            status: 'calendar',
            timeStart: '2026-05-09T10:00:00Z',
            timeEnd: '2026-05-09T11:00:00Z',
            ignoreBefore: '2026-05-08',
        });
        await applyAndPublishOperation(userId, { entityType: 'item', opType: 'create', entityId: 'item-1', snapshot }, { deviceId: 'api:tok-1' });
        expect(warn).toHaveBeenCalled();
        const stored = await itemsDAO.findByOwnerAndId('item-1', userId);
        expect(stored).toBeTruthy();
    });
});

describe('applyAndPublishOperations — batch', () => {
    it('persists multiple ops and stamps the same ts on each', async () => {
        const ops = await applyAndPublishOperations(
            userId,
            [
                { entityType: 'item', opType: 'create', entityId: 'item-1', snapshot: baseInboxItem({ _id: 'item-1' }) },
                { entityType: 'item', opType: 'create', entityId: 'item-2', snapshot: baseInboxItem({ _id: 'item-2', title: 'walk dog' }) },
            ],
            { deviceId: 'device-abc' },
        );
        expect(ops).toHaveLength(2);
        expect(ops[0]!.ts).toBe(ops[1]!.ts);

        const stored = await itemsDAO.findArray({ user: userId });
        expect(stored).toHaveLength(2);
    });

    it('strict mode aborts the entire batch on first violation — no partial writes', async () => {
        const goodSnapshot = baseInboxItem({ _id: 'item-good' });
        const badSnapshot = baseInboxItem({
            _id: 'item-bad',
            status: 'calendar',
            timeStart: '2026-05-09T10:00:00Z',
            timeEnd: '2026-05-09T11:00:00Z',
            ignoreBefore: '2026-05-08',
        });

        await expect(
            applyAndPublishOperations(
                userId,
                [
                    { entityType: 'item', opType: 'create', entityId: 'item-good', snapshot: goodSnapshot },
                    { entityType: 'item', opType: 'create', entityId: 'item-bad', snapshot: badSnapshot },
                ],
                { deviceId: 'device-abc', strict: true },
            ),
        ).rejects.toBeInstanceOf(OperationValidationError);

        const stored = await itemsDAO.findArray({ user: userId });
        expect(stored).toHaveLength(0);
    });
});

describe('applyAndPublishOperation — routine-delete snapshot hydration', () => {
    it('hydrates a routine.delete snapshot from DB before apply, then deletes the row', async () => {
        const routine: RoutineInterface = {
            _id: 'r-1',
            user: userId,
            title: 'water plants',
            routineType: 'nextAction',
            rrule: 'FREQ=DAILY',
            template: {},
            active: true,
            createdTs: '2026-05-08T10:00:00Z',
            updatedTs: '2026-05-08T10:00:00Z',
        };
        await routinesDAO.insertOne(routine);

        const op = await applyAndPublishOperation(userId, { entityType: 'routine', opType: 'delete', entityId: 'r-1', snapshot: null }, { deviceId: 'dev-1' });

        // Snapshot was null on the wire; the pipeline should have looked it up from the DB so the
        // GCal cascade has the pre-delete state to work from.
        expect(op.snapshot).toMatchObject({ _id: 'r-1', user: userId, title: 'water plants' });
        expect(await routinesDAO.findByOwnerAndId('r-1', userId)).toBeNull();
    });

    it('handles a routine.delete whose row was already removed by another device — cascade no-ops', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const op = await applyAndPublishOperation(
            userId,
            { entityType: 'routine', opType: 'delete', entityId: 'r-already-gone', snapshot: null },
            { deviceId: 'dev-1' },
        );
        expect(op.snapshot).toBeNull();
        expect(warn).toHaveBeenCalled();
    });
});

describe('applyAndPublishOperation — notifyChange wiring', () => {
    // Webhook enqueue is the most observable side effect of notifyChange. If a subscription is
    // registered for `item.created`, an inbox-create op should produce a delivery row.
    it('enqueues a webhook delivery when a matching subscription exists', async () => {
        await db.collection('webhookSubscriptions').insertOne({
            _id: 'sub-1',
            user: userId,
            url: 'https://example.test/hook',
            events: ['item.created'],
            secret: 's-1',
            createdTs: '2026-05-08T10:00:00Z',
        } as never);
        await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'create', entityId: 'item-1', snapshot: baseInboxItem() },
            { deviceId: 'api:tok-1' },
        );
        // notifyChange.enqueueWebhookDeliveries is fire-and-forget; poll briefly for the delivery row.
        const deadline = Date.now() + 1000;
        while (Date.now() < deadline) {
            const count = await db.collection('webhookDeliveries').countDocuments({ subscriptionId: 'sub-1', user: userId });
            if (count >= 1) break;
            await new Promise<void>((r) => setTimeout(r, 20));
        }
        const count = await db.collection('webhookDeliveries').countDocuments({ subscriptionId: 'sub-1', user: userId });
        expect(count).toBeGreaterThanOrEqual(1);
    });
});

describe('applyAndPublishOperation — stale ops against superseded entities (2026-08-03 stuck-sync incident)', () => {
    const doneInstanceSnapshot = (id: string, instanceKey: string, updatedTs: string): ItemInterface =>
        ({
            _id: id,
            user: userId,
            status: 'done',
            title: 'Daily standup',
            createdTs: '2026-07-27T07:45:41.659Z',
            updatedTs,
            timeStart: '2026-08-03T10:15:00',
            timeEnd: '2026-08-03T10:30:00',
            calendarInstanceEventId: instanceKey,
        }) as ItemInterface;

    it('update op for a missing item is skipped — not resurrected via upsert', async () => {
        const op = await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'update', entityId: 'gone-item', snapshot: baseInboxItem({ _id: 'gone-item' }) },
            { deviceId: 'dev-1' },
        );

        expect(op._id).toBeTruthy(); // op is still logged for audit
        expect(await itemsDAO.findByOwnerAndId('gone-item', userId)).toBeFalsy();
    });

    it('create op for a missing item still inserts (skip applies to updates only)', async () => {
        await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'create', entityId: 'new-item', snapshot: baseInboxItem({ _id: 'new-item' }) },
            { deviceId: 'dev-1' },
        );
        expect(await itemsDAO.findByOwnerAndId('new-item', userId)).toBeTruthy();
    });

    it('update claiming a calendarInstanceEventId owned by another row is skipped, not thrown', async () => {
        // Successor row (routine regeneration) owns the unique (user, calendarInstanceEventId) key.
        await itemsDAO.insertOne(doneInstanceSnapshot('successor-item', 'evt_abc_20260803T071500Z', '2026-08-03T14:43:05.562Z'));
        // Stale target still exists but without the key (e.g. trashed/reworked row).
        await itemsDAO.insertOne(baseInboxItem({ _id: 'stale-item', updatedTs: '2026-08-01T00:00:00Z' }));

        await expect(
            applyAndPublishOperation(
                userId,
                {
                    entityType: 'item',
                    opType: 'update',
                    entityId: 'stale-item',
                    snapshot: doneInstanceSnapshot('stale-item', 'evt_abc_20260803T071500Z', '2026-08-03T19:08:11.722Z'),
                },
                { deviceId: 'dev-1' },
            ),
        ).resolves.toBeTruthy();

        // Target row untouched; the successor keeps sole ownership of the key.
        const stale = await itemsDAO.findByOwnerAndId('stale-item', userId);
        expect(stale?.status).toBe('inbox');
        expect(await db.collection('items').countDocuments({ user: userId, calendarInstanceEventId: 'evt_abc_20260803T071500Z' })).toBe(1);
    });
});
