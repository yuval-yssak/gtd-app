/** Compare-and-set writers for generated briefs (lib/brief/briefWriter.ts) against Mongo. */
import dayjs from 'dayjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import itemBriefsDAO from '../dataAccess/itemBriefsDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import { writeModelBrief, writeSkippedBrief } from '../lib/brief/briefWriter.js';
import { briefSourceHash } from '../lib/briefSource.js';
import { writeAuthoredBrief } from '../lib/itemBriefs.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import type { BriefOrigin, ItemBriefInterface, ItemInterface, OperationInterface } from '../types/entities.js';

beforeAll(async () => {
    await loadDataAccess('gtd_test_brief_writer');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([db.collection('items').deleteMany({}), db.collection('itemBriefs').deleteMany({}), db.collection('operations').deleteMany({})]);
});

const USER = 'user-a';
const LONG_NOTES = 'Expires in March; need photos and the old passport. The consulate only takes appointments on weekday mornings. Book early.';

async function seedItem(overrides: Partial<ItemInterface> = {}): Promise<ItemInterface> {
    const now = dayjs().toISOString();
    const item: ItemInterface = {
        _id: `item-${Math.random().toString(36).slice(2)}`,
        user: USER,
        status: 'inbox',
        title: 'Renew passport',
        notes: LONG_NOTES,
        createdTs: now,
        updatedTs: now,
        ...overrides,
    };
    await itemsDAO.insertOne(item);
    return item;
}

/** Reads the sweep-selection marker straight off the collection. */
async function markerOf(itemId: string): Promise<boolean | undefined> {
    const row = await db.collection<ItemInterface>('items').findOne({ _id: itemId } as never);
    return row?.briefStale;
}

function idOf(item: ItemInterface): string {
    if (!item._id) throw new Error('seeded item has no _id');
    return item._id;
}

async function seedBrief(item: ItemInterface, origin: BriefOrigin, overrides: Partial<ItemBriefInterface> = {}): Promise<ItemBriefInterface> {
    const past = dayjs().subtract(1, 'day').toISOString();
    const brief: ItemBriefInterface = {
        _id: idOf(item),
        user: USER,
        itemId: idOf(item),
        text: origin === 'skipped' ? null : `${origin} brief`,
        origin,
        sourceHash: briefSourceHash(item.title, item.notes),
        generatedTs: past,
        createdTs: past,
        updatedTs: past,
        ...overrides,
    };
    await itemBriefsDAO.insertOne(brief);
    return brief;
}

const GENERATED = { text: 'Passport renewal still blocked on photos.', model: 'claude-haiku-4-5' };

function modelWrite(item: ItemInterface, extra: { force?: boolean; deviceId?: string; sourceHash?: string } = {}) {
    return writeModelBrief({
        userId: USER,
        itemId: idOf(item),
        sourceHash: extra.sourceHash ?? briefSourceHash(item.title, item.notes),
        generated: GENERATED,
        deviceId: extra.deviceId ?? 'server:brief-ondemand',
        ...(extra.force === undefined ? {} : { force: extra.force }),
    });
}

async function briefOps(): Promise<OperationInterface[]> {
    return db
        .collection('operations')
        .find<OperationInterface>({ entityType: 'itemBrief' } as never)
        .sort({ ts: 1 })
        .toArray();
}

describe('writeModelBrief', () => {
    it('creates a model row (create op, stamped with the given deviceId) and updates it on the second write', async () => {
        const item = await seedItem();
        const first = await modelWrite(item, { deviceId: 'api:token-1' });
        expect(first.outcome).toBe('written');
        const stored = await itemBriefsDAO.findByOwnerAndId(idOf(item), USER);
        expect(stored).toMatchObject({
            itemId: idOf(item),
            text: GENERATED.text,
            origin: 'model',
            model: 'claude-haiku-4-5',
            sourceHash: briefSourceHash(item.title, item.notes),
        });

        const second = await modelWrite(item, { deviceId: 'server:brief-inline' });
        expect(second.outcome).toBe('written');
        const ops = await briefOps();
        expect(ops.map((op) => [op.opType, op.deviceId])).toEqual([
            ['create', 'api:token-1'],
            ['update', 'server:brief-inline'],
        ]);
        if (second.outcome !== 'written') throw new Error('unreachable');
        expect(second.brief.createdTs).toBe(stored?.createdTs);
    });

    it('discards the result when the notes changed since generation (hash mismatch) and writes nothing', async () => {
        const item = await seedItem();
        const staleHash = briefSourceHash(item.title, 'the notes the model actually saw');
        const result = await modelWrite(item, { sourceHash: staleHash });
        expect(result).toEqual({ outcome: 'discarded_stale', brief: null });
        expect(await itemBriefsDAO.countDocuments({})).toBe(0);
        expect(await briefOps()).toHaveLength(0);
    });

    it('clears the briefStale marker once the row is written, retiring the item from the sweep', async () => {
        const item = await seedItem();
        // The DAO stamped the marker on insert; the sweep would select this item.
        expect(await markerOf(idOf(item))).toBe(true);
        expect((await modelWrite(item)).outcome).toBe('written');
        // `false`, not absent: the tri-state keeps "never seen" distinct so the boot backfill
        // cannot reclaim a settled item (see briefStaleMarker.ts).
        expect(await markerOf(idOf(item))).toBe(false);
    });

    it('leaves the marker SET when the CAS discards a stale result — the item must stay selectable', async () => {
        const item = await seedItem();
        const staleHash = briefSourceHash(item.title, 'the notes the model actually saw');
        expect((await modelWrite(item, { sourceHash: staleHash })).outcome).toBe('discarded_stale');
        expect(await markerOf(idOf(item))).toBe(true);
    });

    it('does not settle the marker when the item moves on BETWEEN the CAS read and the clear', async () => {
        // The window the `updatedTs` guard exists for. Editing before the call would only prove
        // `discarded_stale` (nothing written, marker trivially untouched) — the guard has to be
        // exercised on a write that genuinely SUCCEEDS, so the edit lands from inside the upsert.
        const item = await seedItem();
        const hash = briefSourceHash(item.title, item.notes);
        // The brief row lands through the op pipeline, so hooking the op insert puts the edit in
        // the exact gap between the CAS decision and the settle. The edit deliberately leaves
        // `updatedTs` alone: the guard must hold on CONTENT, not on a timestamp a writer could
        // forget to bump.
        const realInsert = operationsDAO.insertOne.bind(operationsDAO);
        const spy = vi.spyOn(operationsDAO, 'insertOne').mockImplementation(async (...args) => {
            const result = await realInsert(...args);
            await itemsDAO.updateOne({ _id: idOf(item) }, { $set: { notes: `${LONG_NOTES} plus a late edit.` } });
            return result;
        });
        const written = await writeModelBrief({ userId: USER, itemId: idOf(item), sourceHash: hash, generated: GENERATED, deviceId: 'test' });
        spy.mockRestore();

        expect(written.outcome).toBe('written');
        // The brief describes the OLD content, so the item must stay selectable for the new one.
        expect(await markerOf(idOf(item))).toBe(true);
    });

    it('discards when the item was deleted in the meantime', async () => {
        const item = await seedItem();
        await itemsDAO.deleteByOwner(idOf(item), USER);
        expect((await modelWrite(item)).outcome).toBe('discarded_stale');
    });

    it('refuses to overwrite a pinned (user/agent) brief unless force', async () => {
        const item = await seedItem();
        const pinned = await seedBrief(item, 'user');
        const refused = await modelWrite(item);
        expect(refused).toEqual({ outcome: 'pinned', brief: expect.objectContaining({ origin: 'user', text: 'user brief' }) });
        expect(await briefOps()).toHaveLength(0);

        const forced = await modelWrite(item, { force: true });
        expect(forced.outcome).toBe('written');
        const stored = await itemBriefsDAO.findByOwnerAndId(idOf(item), USER);
        expect(stored).toMatchObject({ origin: 'model', text: GENERATED.text, createdTs: pinned.createdTs });
        const [op] = await briefOps();
        expect(op?.opType).toBe('update');
    });

    it('replaces a stale model or skipped row without force', async () => {
        const item = await seedItem();
        await seedBrief(item, 'skipped', { sourceHash: 'stale' });
        expect((await modelWrite(item)).outcome).toBe('written');
        expect((await itemBriefsDAO.findByOwnerAndId(idOf(item), USER))?.origin).toBe('model');
    });

    it('serializes concurrent writes on one item: exactly one create then updates, never two creates', async () => {
        const item = await seedItem();
        await Promise.all([modelWrite(item), modelWrite(item), modelWrite(item)]);
        const ops = await briefOps();
        expect(ops.map((op) => op.opType)).toEqual(['create', 'update', 'update']);
    });

    it('shares the lock with the authored writer: a PUT racing a generation never yields two creates', async () => {
        const item = await seedItem();
        const authored = writeAuthoredBrief({ userId: USER, itemId: idOf(item), item, text: 'mine', origin: 'agent', deviceId: 'api:t' });
        await Promise.all([modelWrite(item, { force: true }), authored, modelWrite(item, { force: true })]);
        const ops = await briefOps();
        expect(ops.filter((op) => op.opType === 'create')).toHaveLength(1);
        expect(ops).toHaveLength(3);
    });
});

describe('writeSkippedBrief', () => {
    function skipWrite(item: ItemInterface, force?: boolean) {
        return writeSkippedBrief({
            userId: USER,
            itemId: idOf(item),
            sourceHash: briefSourceHash(item.title, item.notes),
            deviceId: 'server:brief-ondemand',
            ...(force === undefined ? {} : { force }),
        });
    }

    it('writes a text:null skipped row when no row exists', async () => {
        const item = await seedItem({ notes: 'short' });
        const result = await skipWrite(item);
        expect(result.outcome).toBe('written');
        expect(await itemBriefsDAO.findByOwnerAndId(idOf(item), USER)).toMatchObject({ text: null, origin: 'skipped' });
        expect(result.brief).not.toHaveProperty('model');
    });

    it('does not overwrite a fresh model brief (reports unchanged) but replaces a stale one', async () => {
        const item = await seedItem({ notes: 'short' });
        const fresh = await seedBrief(item, 'model');
        expect(await skipWrite(item)).toEqual({ outcome: 'unchanged', brief: expect.objectContaining({ origin: 'model', text: fresh.text }) });
        expect(await briefOps()).toHaveLength(0);

        await itemBriefsDAO.updateOne({ _id: idOf(item) }, { $set: { sourceHash: 'stale' } });
        expect((await skipWrite(item)).outcome).toBe('written');
        expect((await itemBriefsDAO.findByOwnerAndId(idOf(item), USER))?.origin).toBe('skipped');
    });

    it('force rewrites even a fresh row as skipped (an explicit regenerate on short notes recomputes the decision)', async () => {
        const item = await seedItem({ notes: 'short' });
        await seedBrief(item, 'model');
        expect((await skipWrite(item, true)).outcome).toBe('written');
        expect(await itemBriefsDAO.findByOwnerAndId(idOf(item), USER)).toMatchObject({ origin: 'skipped', text: null });
    });

    it('never overwrites a pinned brief without force, and discards on a hash mismatch', async () => {
        const item = await seedItem({ notes: 'short' });
        await seedBrief(item, 'agent', { sourceHash: 'stale' });
        expect((await skipWrite(item)).outcome).toBe('pinned');
        expect((await skipWrite(item, true)).outcome).toBe('written');

        const moved = await seedItem({ notes: 'short' });
        await itemsDAO.updateOne({ _id: idOf(moved) }, { $set: { notes: 'edited' } });
        expect((await skipWrite(moved)).outcome).toBe('discarded_stale');
    });
});
