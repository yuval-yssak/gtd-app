/**
 * propagateRoutineNotesToItems (calendarItemNotes.ts) — no-op safety and the trash-resurrection
 * race. This helper runs on the fire-and-forget GCal pushback leg, concurrently with the awaited
 * PATCH item regeneration, so it must never rewrite an unchanged item (op-log churn) and never
 * resurrect an item that was trashed between its read and its write (the v1RoutineEditPropagation
 * CI flake).
 */
import { randomUUID } from 'node:crypto';
import dayjs from 'dayjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import itemsDAO from '../dataAccess/itemsDAO.js';
import { propagateRoutineNotesToItems } from '../lib/calendarItemNotes.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import type { ItemInterface } from '../types/entities.js';

const USER_ID = 'user-notes-1';
const ROUTINE_ID = 'routine-notes-1';

beforeAll(async () => {
    await loadDataAccess('gtd_test_calendar_item_notes');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([db.collection('items').deleteMany({}), db.collection('operations').deleteMany({})]);
    vi.restoreAllMocks();
});

async function seedItem(overrides: Partial<ItemInterface> = {}): Promise<ItemInterface> {
    const now = dayjs().toISOString();
    const item: ItemInterface = {
        _id: randomUUID(),
        user: USER_ID,
        status: 'calendar',
        title: 'Morning swim',
        routineId: ROUTINE_ID,
        timeStart: dayjs().add(1, 'day').format('YYYY-MM-DDT09:00:00'),
        timeEnd: dayjs().add(1, 'day').format('YYYY-MM-DDT10:00:00'),
        createdTs: now,
        updatedTs: now,
        ...overrides,
    };
    await itemsDAO.insertOne(item);
    return item;
}

async function opsCount(): Promise<number> {
    return db.collection('operations').countDocuments({ user: USER_ID });
}

describe('propagateRoutineNotesToItems', () => {
    it('stamps changed notes onto live items and records one op per item', async () => {
        const item = await seedItem();

        const ops = await propagateRoutineNotesToItems(ROUTINE_ID, 'bring goggles', USER_ID);

        expect(ops).toHaveLength(1);
        const after = await itemsDAO.findOne({ _id: item._id } as never);
        expect(after?.notes).toBe('bring goggles');
        expect(await opsCount()).toBe(1);
    });

    it('clears notes when the routine notes are removed', async () => {
        const item = await seedItem({ notes: 'stale' });

        const ops = await propagateRoutineNotesToItems(ROUTINE_ID, undefined, USER_ID);

        expect(ops).toHaveLength(1);
        const after = await itemsDAO.findOne({ _id: item._id } as never);
        expect(after?.notes).toBeUndefined();
    });

    it('is a complete no-op when every item already carries the target notes', async () => {
        const withNotes = await seedItem({ notes: 'bring goggles' });
        await seedItem({ timeStart: dayjs().add(2, 'day').format('YYYY-MM-DDT09:00:00') });

        const matching = await propagateRoutineNotesToItems(ROUTINE_ID, 'bring goggles', USER_ID);
        expect(matching).toHaveLength(1); // only the bare item was stale

        const repeat = await propagateRoutineNotesToItems(ROUTINE_ID, 'bring goggles', USER_ID);
        expect(repeat).toHaveLength(0);
        expect(await opsCount()).toBe(1);

        // updatedTs untouched on the already-matching item — no silent LWW bump.
        const untouched = await itemsDAO.findOne({ _id: withNotes._id } as never);
        expect(untouched?.updatedTs).toBe(withNotes.updatedTs);
    });

    it('treats an absent target and empty-string target as the same (no churn)', async () => {
        await seedItem();

        const ops = await propagateRoutineNotesToItems(ROUTINE_ID, undefined, USER_ID);
        expect(ops).toHaveLength(0);
        expect(await opsCount()).toBe(0);
    });

    it('skips an item re-homed to another status between its read and its write', async () => {
        // Same race window as the trash case, but the concurrent writer moved the item to a live
        // non-calendar status — proves the `status: 'calendar'` write filter gates, not trash specifically.
        const item = await seedItem();
        const staleSnapshot = { ...item };
        await itemsDAO.updateMany({ _id: item._id } as never, { $set: { status: 'nextAction' } });
        vi.spyOn(itemsDAO, 'findArray').mockResolvedValueOnce([staleSnapshot]);

        const ops = await propagateRoutineNotesToItems(ROUTINE_ID, 'bring goggles', USER_ID);

        expect(ops).toHaveLength(0);
        const after = await itemsDAO.findOne({ _id: item._id } as never);
        expect(after?.status).toBe('nextAction');
        expect(after?.notes).toBeUndefined();
        expect(await opsCount()).toBe(0);
    });

    it('never resurrects an item trashed between its read and its write', async () => {
        // Reproduce the race window deterministically: the helper reads a live snapshot, but by the
        // time it writes, a concurrent regen has trashed the row. The stale-snapshot findArray mock
        // stands in for the pre-trash read; the DB row is already trashed.
        const item = await seedItem();
        const staleSnapshot = { ...item };
        await itemsDAO.updateMany({ _id: item._id } as never, { $set: { status: 'trash' } });
        vi.spyOn(itemsDAO, 'findArray').mockResolvedValueOnce([staleSnapshot]);

        const ops = await propagateRoutineNotesToItems(ROUTINE_ID, 'bring goggles', USER_ID);

        expect(ops).toHaveLength(0);
        const after = await itemsDAO.findOne({ _id: item._id } as never);
        expect(after?.status).toBe('trash');
        expect(after?.notes).toBeUndefined();
        expect(await opsCount()).toBe(0);
    });
});
