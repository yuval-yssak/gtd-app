/** Proves the inline hook is WIRED into both apply paths: real Mongo, real service, fake model
 * (BRIEF_FAKE_MODEL=1), timers flushed explicitly. Deleting `maybeScheduleInlineBriefs` from
 * either path in applyOperation.ts fails this file. */
import dayjs from 'dayjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetDefaultStoreForTests } from '../auth/rateLimitMiddleware.js';
import itemBriefsDAO from '../dataAccess/itemBriefsDAO.js';
import { applyAndPublishOperation, applyAndPublishOperations, type RawOperation } from '../lib/applyOperation.js';
import { __flushInlineBriefTimersForTests, __pendingInlineBriefCountForTests, __resetInlineBriefTimersForTests } from '../lib/brief/briefInlineHook.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import type { ItemInterface, OperationInterface } from '../types/entities.js';

beforeAll(async () => {
    await loadDataAccess('gtd_test_brief_inline_integration');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([db.collection('items').deleteMany({}), db.collection('itemBriefs').deleteMany({}), db.collection('operations').deleteMany({})]);
    __resetDefaultStoreForTests();
    vi.stubEnv('BRIEF_INLINE_ON_WRITE', '1');
    vi.stubEnv('BRIEF_FAKE_MODEL', '1');
});

afterEach(() => {
    __resetInlineBriefTimersForTests();
    vi.unstubAllEnvs();
});

const USER = 'user-inline';
// Comfortably over the 160-char skip threshold so the model (fake) path is exercised.
const LONG_NOTES =
    'Expires in March; need photos and the old passport. The consulate only takes appointments on weekday mornings, ' +
    'and the earliest slot is usually three weeks out, so the photos have to be done before booking.';

function itemCreate(id: string, notes = LONG_NOTES): RawOperation {
    const now = dayjs().toISOString();
    const snapshot: ItemInterface = { _id: id, user: USER, status: 'inbox', title: `Item ${id}`, notes, createdTs: now, updatedTs: now };
    return { entityType: 'item', entityId: id, opType: 'create', snapshot };
}

async function inlineBriefOps(): Promise<OperationInterface[]> {
    return db
        .collection('operations')
        .find<OperationInterface>({ entityType: 'itemBrief' } as never)
        .toArray();
}

describe('inline brief hook wiring', () => {
    it('single-op path: a device item write schedules a generation that lands a model brief op stamped server:brief-inline', async () => {
        await applyAndPublishOperation(USER, itemCreate('single'), { deviceId: 'device-1' });
        expect(__pendingInlineBriefCountForTests()).toBe(1);
        await __flushInlineBriefTimersForTests();
        const [op] = await inlineBriefOps();
        expect(op).toMatchObject({ entityId: 'single', opType: 'create', deviceId: 'server:brief-inline' });
        expect(await itemBriefsDAO.findByOwnerAndId('single', USER)).toMatchObject({
            origin: 'model',
            model: 'fake',
            text: '[fake] Expires in March; need photos and the old passport',
        });
    });

    it('batch path: a /sync/push-style flush schedules one generation per item and records skip markers for short notes', async () => {
        await applyAndPublishOperations(USER, [itemCreate('a'), itemCreate('b'), itemCreate('c', 'short')], { deviceId: 'device-1' });
        expect(__pendingInlineBriefCountForTests()).toBe(3);
        await __flushInlineBriefTimersForTests();
        const ops = await inlineBriefOps();
        expect(ops.map((op) => op.entityId).sort()).toEqual(['a', 'b', 'c']);
        expect(ops.every((op) => op.deviceId === 'server:brief-inline')).toBe(true);
        expect((await itemBriefsDAO.findByOwnerAndId('c', USER))?.origin).toBe('skipped');
    });

    it('never generates for a done or trash item, even though the write itself schedules a timer', async () => {
        const now = dayjs().toISOString();
        const snapshot: ItemInterface = {
            _id: 'closed-1',
            user: USER,
            status: 'done',
            title: 'Item closed-1',
            notes: LONG_NOTES,
            createdTs: now,
            updatedTs: now,
        };
        await applyAndPublishOperation(USER, { entityType: 'item', entityId: 'closed-1', opType: 'create', snapshot }, { deviceId: 'dev-1' });
        await __flushInlineBriefTimersForTests();
        expect(await itemBriefsDAO.findByOwnerAndId('closed-1', USER)).toBeNull();
        expect(await inlineBriefOps()).toHaveLength(0);
    });

    it('generates once a closed item is revived to a live status', async () => {
        const now = dayjs().toISOString();
        const base: ItemInterface = { _id: 'revive-1', user: USER, status: 'trash', title: 'Item revive-1', notes: LONG_NOTES, createdTs: now, updatedTs: now };
        await applyAndPublishOperation(USER, { entityType: 'item', entityId: 'revive-1', opType: 'create', snapshot: base }, { deviceId: 'dev-1' });
        await __flushInlineBriefTimersForTests();
        expect(await itemBriefsDAO.findByOwnerAndId('revive-1', USER)).toBeNull();

        const revived: ItemInterface = { ...base, status: 'nextAction', updatedTs: dayjs().add(1, 'second').toISOString() };
        await applyAndPublishOperation(USER, { entityType: 'item', entityId: 'revive-1', opType: 'update', snapshot: revived }, { deviceId: 'dev-1' });
        await __flushInlineBriefTimersForTests();
        expect(await itemBriefsDAO.findByOwnerAndId('revive-1', USER)).toMatchObject({ origin: 'model' });
    });

    it('server-stamped writes and a disabled flag schedule nothing', async () => {
        await applyAndPublishOperation(USER, itemCreate('gcal'), { deviceId: 'server' });
        vi.stubEnv('BRIEF_INLINE_ON_WRITE', '');
        await applyAndPublishOperation(USER, itemCreate('off'), { deviceId: 'device-1' });
        expect(__pendingInlineBriefCountForTests()).toBe(0);
    });

    it('the brief write itself (server:brief-inline) never re-arms the hook — no feedback loop', async () => {
        await applyAndPublishOperation(USER, itemCreate('loop'), { deviceId: 'device-1' });
        await __flushInlineBriefTimersForTests();
        expect(__pendingInlineBriefCountForTests()).toBe(0);
        expect(await inlineBriefOps()).toHaveLength(1);
    });
});
