/**
 * `statusBeforeDone`: the open status an item held when it was completed, so a done item can say
 * what it was ("Calendar · Tue 14:00–15:00"). Stamped by the apply pipeline from the STORED row on
 * every open→done transition — /sync/push, /v1 PATCH, POST /complete and /v1/operations/batch all
 * converge there — and carried forward on later done edits from a device that has not pulled it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import { applyAndPublishOperation, applyAndPublishOperations } from '../lib/applyOperation.js';
import { stampStatusBeforeDone, withoutStatusBeforeDone } from '../lib/statusBeforeDone.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import type { ItemInterface } from '../types/entities.js';

beforeAll(async () => {
    await loadDataAccess('gtd_test');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([db.collection('items').deleteMany({}), db.collection('operations').deleteMany({})]);
});

const userId = 'user-status-before-done';
const itemId = 'item-sbd-1';
const T0 = '2026-10-20T10:00:00.000Z';
const T1 = '2026-10-20T10:05:00.000Z';

const stored = (overrides: Partial<ItemInterface> = {}): ItemInterface => ({
    _id: itemId,
    user: userId,
    status: 'calendar',
    title: 'Dentist',
    timeStart: '2026-10-21T14:00:00',
    timeEnd: '2026-10-21T15:00:00',
    createdTs: T0,
    updatedTs: T0,
    ...overrides,
});

const completed = (overrides: Partial<ItemInterface> = {}): ItemInterface => ({ ...stored(), status: 'done', updatedTs: T1, ...overrides });

describe('stampStatusBeforeDone (pure)', () => {
    it.each(['inbox', 'nextAction', 'calendar', 'waitingFor', 'somedayMaybe'] as const)(
        'stamps the stored %s status on an open → done transition',
        (status) => {
            expect(stampStatusBeforeDone(stored({ status }), completed()).statusBeforeDone).toBe(status);
        },
    );

    it('keeps the value the device sent — its queue may collapse inbox → calendar → done into one op the server sees from inbox', () => {
        const incoming = completed({ statusBeforeDone: 'calendar' });
        expect(stampStatusBeforeDone(stored({ status: 'inbox' }), incoming)).toBe(incoming);
    });

    it('carries the stored value onto a done → done edit from a device that has not pulled it', () => {
        const existing = completed({ statusBeforeDone: 'waitingFor' });
        expect(stampStatusBeforeDone(existing, completed({ title: 'edited' })).statusBeforeDone).toBe('waitingFor');
    });

    it('keeps an incoming value on a done → done edit', () => {
        const incoming = completed({ statusBeforeDone: 'nextAction' });
        expect(stampStatusBeforeDone(completed({ statusBeforeDone: 'calendar' }), incoming)).toBe(incoming);
    });

    it('drops it when the item is revived to an open status — a stored open row never holds a stale value', () => {
        const revived = { ...stored({ status: 'nextAction', statusBeforeDone: 'calendar' }), updatedTs: T1 };
        expect(stampStatusBeforeDone(completed({ statusBeforeDone: 'calendar' }), revived)).not.toHaveProperty('statusBeforeDone');
    });

    it('leaves an open snapshot without the field untouched', () => {
        const incoming = { ...stored({ status: 'nextAction' }), updatedTs: T1 };
        expect(stampStatusBeforeDone(stored(), incoming)).toBe(incoming);
    });

    it('carries it onto a trashed done item from a device that has not pulled it', () => {
        expect(stampStatusBeforeDone(completed({ statusBeforeDone: 'waitingFor' }), completed({ status: 'trash' })).statusBeforeDone).toBe('waitingFor');
    });

    it('never stamps a trash snapshot from an open row — it records what came before DONE', () => {
        const incoming = completed({ status: 'trash' });
        expect(stampStatusBeforeDone(stored({ status: 'nextAction' }), incoming)).toBe(incoming);
    });

    it('drops a value a trash snapshot carries over an open row — a trashed open item was never done', () => {
        // A device that revived the item locally may still hold the field from the old completion.
        const incoming = completed({ status: 'trash', statusBeforeDone: 'calendar' });
        expect(stampStatusBeforeDone(stored({ status: 'nextAction' }), incoming)).not.toHaveProperty('statusBeforeDone');
    });

    it('stamps nothing when the stored row was trash — it held no open status to remember', () => {
        const incoming = completed();
        expect(stampStatusBeforeDone(stored({ status: 'trash' }), incoming)).toBe(incoming);
    });
});

describe('withoutStatusBeforeDone (pure)', () => {
    it('removes the field, and returns the same item when there is none', () => {
        expect(withoutStatusBeforeDone(completed({ statusBeforeDone: 'calendar' }))).not.toHaveProperty('statusBeforeDone');
        const bare = completed();
        expect(withoutStatusBeforeDone(bare)).toBe(bare);
    });
});

describe('statusBeforeDone through the apply pipeline', () => {
    it('an open-status CREATE carrying the field lands without it (no stored row to compare against)', async () => {
        await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'create', entityId: itemId, snapshot: stored({ statusBeforeDone: 'calendar' }) },
            { deviceId: 'device-A' },
        );
        expect((await itemsDAO.findByOwnerAndId(itemId, userId))?.statusBeforeDone).toBeUndefined();
    });

    it('a done CREATE keeps the value it carries', async () => {
        await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'create', entityId: itemId, snapshot: completed({ statusBeforeDone: 'nextAction' }) },
            { deviceId: 'device-A' },
        );
        expect((await itemsDAO.findByOwnerAndId(itemId, userId))?.statusBeforeDone).toBe('nextAction');
    });

    it('a completion that never names the prior status records it on the row AND the logged op', async () => {
        await itemsDAO.insertOne(stored());
        await applyAndPublishOperation(userId, { entityType: 'item', opType: 'update', entityId: itemId, snapshot: completed() }, { deviceId: 'device-A' });
        expect((await itemsDAO.findByOwnerAndId(itemId, userId))?.statusBeforeDone).toBe('calendar');
        const [logged] = await operationsDAO.findArray({ user: userId });
        expect((logged?.snapshot as ItemInterface | undefined)?.statusBeforeDone).toBe('calendar');
    });

    it('a collapsed push (the row is still inbox on the server) keeps the calendar status the device recorded', async () => {
        const { timeStart: _ts, timeEnd: _te, ...untimed } = stored();
        await itemsDAO.insertOne({ ...untimed, status: 'inbox' });
        await applyAndPublishOperations(
            userId,
            [{ entityType: 'item', opType: 'update', entityId: itemId, snapshot: completed({ statusBeforeDone: 'calendar' }) }],
            { deviceId: 'device-A' },
        );
        expect((await itemsDAO.findByOwnerAndId(itemId, userId))?.statusBeforeDone).toBe('calendar');
    });

    it('the multi-op apply (behind /sync/push and /v1/operations/batch) stamps it too', async () => {
        const { timeStart: _ts, timeEnd: _te, ...untimed } = stored();
        await itemsDAO.insertOne({ ...untimed, status: 'waitingFor', waitingForPersonId: 'p-1' });
        await applyAndPublishOperations(userId, [{ entityType: 'item', opType: 'update', entityId: itemId, snapshot: completed() }], { deviceId: 'device-B' });
        expect((await itemsDAO.findByOwnerAndId(itemId, userId))?.statusBeforeDone).toBe('waitingFor');
    });

    it('a revive clears it on the row, so a later POST-/complete-style rebuild from the row cannot echo a stale value', async () => {
        await itemsDAO.insertOne(completed({ statusBeforeDone: 'calendar' }));
        const { timeStart: _ts, timeEnd: _te, statusBeforeDone: _s, ...untimed } = completed({ statusBeforeDone: 'calendar' });
        await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'update', entityId: itemId, snapshot: { ...untimed, status: 'nextAction', statusBeforeDone: 'calendar' } },
            { deviceId: 'device-A' },
        );
        expect((await itemsDAO.findByOwnerAndId(itemId, userId))?.statusBeforeDone).toBeUndefined();
    });

    it('a later edit of the done item from a device that lacks the field does not erase it', async () => {
        await itemsDAO.insertOne(completed({ statusBeforeDone: 'calendar' }));
        await applyAndPublishOperation(
            userId,
            { entityType: 'item', opType: 'update', entityId: itemId, snapshot: completed({ notes: 'went well', updatedTs: '2026-10-20T11:00:00.000Z' }) },
            { deviceId: 'device-C' },
        );
        expect((await itemsDAO.findByOwnerAndId(itemId, userId))?.statusBeforeDone).toBe('calendar');
    });
});
