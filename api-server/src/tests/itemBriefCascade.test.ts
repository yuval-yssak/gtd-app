/** Direct coverage of the brief-removal cascade shared by item hard-delete, reassign, and the
 * maintenance delete scripts. The /sync/push and reassign paths are covered end-to-end in
 * itemBriefSync.test.ts; this pins the module's own contract (op shape, provenance, no-op). */
import dayjs from 'dayjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import itemBriefsDAO from '../dataAccess/itemBriefsDAO.js';
import { cascadeItemBriefRemoval } from '../lib/itemBriefCascade.js';
import * as notifyChangeModule from '../lib/notifyChange.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import type { ItemBriefInterface, OperationInterface } from '../types/entities.js';

beforeAll(async () => {
    await loadDataAccess('gtd_test');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([db.collection('itemBriefs').deleteMany({}), db.collection('operations').deleteMany({})]);
    vi.restoreAllMocks();
});

const USER = 'user-brief-cascade';
const OTHER_USER = 'user-brief-cascade-other';

async function seedBrief(itemId: string, user = USER): Promise<ItemBriefInterface> {
    const now = dayjs().toISOString();
    const brief: ItemBriefInterface = {
        _id: itemId,
        user,
        itemId,
        text: 'brief',
        origin: 'user',
        sourceHash: 'h',
        generatedTs: now,
        createdTs: now,
        updatedTs: now,
    };
    await itemBriefsDAO.insertOne(brief);
    return brief;
}

async function recordedOps(): Promise<OperationInterface[]> {
    return db
        .collection('operations')
        .find<OperationInterface>({} as never)
        .toArray();
}

describe('cascadeItemBriefRemoval', () => {
    it('deletes the row, records a server-stamped itemBrief delete op, and fans it out', async () => {
        await seedBrief('item-1');
        const notify = vi.spyOn(notifyChangeModule, 'notifyChange').mockResolvedValue(undefined);

        await cascadeItemBriefRemoval(USER, 'item-1');

        expect(await itemBriefsDAO.findByOwnerAndId('item-1', USER)).toBeNull();
        const ops = await recordedOps();
        expect(ops).toHaveLength(1);
        const [op] = ops;
        if (!op) throw new Error('expected one op');
        expect(op).toMatchObject({
            user: USER,
            entityType: 'itemBrief',
            entityId: 'item-1',
            opType: 'delete',
            snapshot: null,
            deviceId: 'server:brief-cascade',
        });
        expect(notify).toHaveBeenCalledWith(op, {});
    });

    it('is a no-op (no row touched, no op recorded) when the item has no brief', async () => {
        const notify = vi.spyOn(notifyChangeModule, 'notifyChange').mockResolvedValue(undefined);
        await cascadeItemBriefRemoval(USER, 'no-brief');
        expect(await recordedOps()).toEqual([]);
        expect(notify).not.toHaveBeenCalled();
    });

    it("is owner-scoped: never touches another user's brief under the same item id", async () => {
        await seedBrief('shared-id', OTHER_USER);
        vi.spyOn(notifyChangeModule, 'notifyChange').mockResolvedValue(undefined);
        await cascadeItemBriefRemoval(USER, 'shared-id');
        expect(await itemBriefsDAO.findByOwnerAndId('shared-id', OTHER_USER)).not.toBeNull();
        expect(await recordedOps()).toEqual([]);
    });

    it('is idempotent: a second run after the row is gone records nothing more', async () => {
        await seedBrief('item-2');
        vi.spyOn(notifyChangeModule, 'notifyChange').mockResolvedValue(undefined);
        await cascadeItemBriefRemoval(USER, 'item-2');
        await cascadeItemBriefRemoval(USER, 'item-2');
        expect((await recordedOps()).map((op) => op.opType)).toEqual(['delete']);
    });
});
