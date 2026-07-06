/**
 * Behavioural coverage for the nextAction routine-edit → open-item propagation orchestrator:
 * what gets written to IDB, which fields survive a hand-tweak, when dates are recomputed, and
 * the exhausted-schedule trash+deactivate path (including its undo half).
 */
import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#api/syncClient', async () => await import('../api/syncClient.mock.ts'));

import { persistRoutineTextEdit, restoreTrashedRoutineItem, syncOpenItemAfterNextActionEdit } from '../db/routineItemHelpers';
import { waitForPendingFlush } from '../db/syncHelpers';
import type { MyDB, StoredItem, StoredRoutine } from '../types/MyDB';
import { openTestDB } from './openTestDB';

const USER_ID = 'user-1';

function buildRoutine(overrides: Partial<StoredRoutine> = {}): StoredRoutine {
    return {
        _id: 'routine-1',
        userId: USER_ID,
        title: 'Water plants',
        routineType: 'nextAction',
        rrule: 'FREQ=DAILY;INTERVAL=1',
        template: {},
        active: true,
        createdTs: '2026-01-01T00:00:00.000Z',
        updatedTs: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

function buildOpenItem(overrides: Partial<StoredItem> = {}): StoredItem {
    return {
        _id: 'item-1',
        userId: USER_ID,
        status: 'nextAction',
        title: 'Water plants',
        routineId: 'routine-1',
        expectedBy: '2026-07-06',
        ignoreBefore: '2026-07-06',
        createdTs: '2026-07-01T00:00:00.000Z',
        updatedTs: '2026-07-01T00:00:00.000Z',
        ...overrides,
    };
}

let db: IDBPDatabase<MyDB>;

beforeEach(async () => {
    // Monday 2026-07-06 local — keeps rrule recompute assertions deterministic.
    vi.useFakeTimers({ toFake: ['Date'] }).setSystemTime(new Date('2026-07-06T10:00:00'));
    db = await openTestDB();
});

afterEach(async () => {
    await waitForPendingFlush().catch(() => {});
    db.close();
    vi.useRealTimers();
    vi.clearAllMocks();
});

describe('syncOpenItemAfterNextActionEdit — content merge', () => {
    it('adopts template additions on a clean open item and queues a sync op', async () => {
        const previous = buildRoutine();
        const next = buildRoutine({ template: { workContextIds: ['wc-1'], energy: 'high' } });
        await db.put('items', buildOpenItem());

        const result = await syncOpenItemAfterNextActionEdit(db, { previous, next, scheduleChanged: false });
        expect(result.outcome).toBe('updated');
        const stored = await db.get('items', 'item-1');
        expect(stored?.workContextIds).toEqual(['wc-1']);
        expect(stored?.energy).toBe('high');
        const ops = await db.getAll('syncOperations');
        expect(ops.filter((op) => op.entityId === 'item-1' && op.opType === 'update')).toHaveLength(1);
    });

    it('preserves a hand-tweaked field while adopting the rest', async () => {
        const previous = buildRoutine({ template: { energy: 'low' } });
        const next = buildRoutine({ template: { energy: 'high', time: 15 } });
        await db.put('items', buildOpenItem({ energy: 'medium' }));

        const result = await syncOpenItemAfterNextActionEdit(db, { previous, next, scheduleChanged: false });
        expect(result.outcome).toBe('updated');
        const stored = await db.get('items', 'item-1');
        expect(stored?.energy).toBe('medium');
        expect(stored?.time).toBe(15);
    });

    it('reports unchanged (and writes nothing) when the edit alters no stamped field', async () => {
        const previous = buildRoutine({ template: { energy: 'low' } });
        const next = buildRoutine({ template: { energy: 'low' } });
        const item = buildOpenItem({ energy: 'low' });
        await db.put('items', item);

        const result = await syncOpenItemAfterNextActionEdit(db, { previous, next, scheduleChanged: false });
        expect(result.outcome).toBe('unchanged');
        const stored = await db.get('items', 'item-1');
        expect(stored?.updatedTs).toBe(item.updatedTs);
        expect(await db.getAll('syncOperations')).toHaveLength(0);
    });

    it('never touches a transformed item — only native nextAction status counts', async () => {
        const previous = buildRoutine();
        const next = buildRoutine({ template: { energy: 'high' } });
        await db.put('items', buildOpenItem({ status: 'waitingFor' }));

        const result = await syncOpenItemAfterNextActionEdit(db, { previous, next, scheduleChanged: false });
        expect(result.outcome).toBe('noOpenItem');
        const stored = await db.get('items', 'item-1');
        expect(stored?.energy).toBeUndefined();
    });

    it('never propagates for a paused routine', async () => {
        const previous = buildRoutine();
        const next = buildRoutine({ template: { energy: 'high' }, active: false });
        await db.put('items', buildOpenItem());

        const result = await syncOpenItemAfterNextActionEdit(db, { previous, next, scheduleChanged: false });
        expect(result.outcome).toBe('noOpenItem');
    });
});

describe('syncOpenItemAfterNextActionEdit — schedule recompute', () => {
    it('recomputes expectedBy/ignoreBefore from the new rrule (tickler moves in lockstep)', async () => {
        const previous = buildRoutine();
        const next = buildRoutine({ rrule: 'FREQ=WEEKLY;BYDAY=WE' });
        await db.put('items', buildOpenItem());

        const result = await syncOpenItemAfterNextActionEdit(db, { previous, next, scheduleChanged: true });
        expect(result.outcome).toBe('updated');
        const stored = await db.get('items', 'item-1');
        // Today is Monday 2026-07-06; the first Wednesday occurrence is 2026-07-08.
        expect(stored?.expectedBy).toBe('2026-07-08');
        expect(stored?.ignoreBefore).toBe('2026-07-08');
    });

    it('overwrites a manually rescheduled date — schedule edits win (agreed semantics)', async () => {
        const previous = buildRoutine();
        const next = buildRoutine({ rrule: 'FREQ=WEEKLY;BYDAY=WE' });
        await db.put('items', buildOpenItem({ expectedBy: '2026-08-20', ignoreBefore: '2026-07-06' }));

        const result = await syncOpenItemAfterNextActionEdit(db, { previous, next, scheduleChanged: true });
        expect(result.outcome).toBe('updated');
        const stored = await db.get('items', 'item-1');
        expect(stored?.expectedBy).toBe('2026-07-08');
        expect(stored?.ignoreBefore).toBe('2026-07-08');
    });

    it('applies content merge and date recompute in one write', async () => {
        const previous = buildRoutine();
        const next = buildRoutine({ rrule: 'FREQ=WEEKLY;BYDAY=WE', title: 'Water all plants' });
        await db.put('items', buildOpenItem());

        const result = await syncOpenItemAfterNextActionEdit(db, { previous, next, scheduleChanged: true });
        expect(result.outcome).toBe('updated');
        const stored = await db.get('items', 'item-1');
        expect(stored?.title).toBe('Water all plants');
        expect(stored?.expectedBy).toBe('2026-07-08');
        const ops = await db.getAll('syncOperations');
        expect(ops.filter((op) => op.entityId === 'item-1')).toHaveLength(1);
    });

    it('reports unchanged when the recomputed date and content both match the item', async () => {
        const previous = buildRoutine();
        const next = buildRoutine();
        await db.put('items', buildOpenItem({ expectedBy: '2026-07-06', ignoreBefore: '2026-07-06' }));

        const result = await syncOpenItemAfterNextActionEdit(db, { previous, next, scheduleChanged: true });
        expect(result.outcome).toBe('unchanged');
        expect(await db.getAll('syncOperations')).toHaveLength(0);
    });
});

describe('syncOpenItemAfterNextActionEdit — exhausted schedule', () => {
    it('trashes the pending item, deactivates the routine, and returns the pre-trash snapshot', async () => {
        const previous = buildRoutine();
        const next = buildRoutine({ rrule: 'FREQ=DAILY;UNTIL=20260101T235959Z' });
        await db.put('routines', next);
        const item = buildOpenItem();
        await db.put('items', item);

        const result = await syncOpenItemAfterNextActionEdit(db, { previous, next, scheduleChanged: true });
        expect(result.outcome).toBe('trashedExhausted');
        const storedItem = await db.get('items', 'item-1');
        expect(storedItem?.status).toBe('trash');
        const storedRoutine = await db.get('routines', 'routine-1');
        expect(storedRoutine?.active).toBe(false);
        if (result.outcome !== 'trashedExhausted') throw new Error('expected trashedExhausted outcome');
        expect(result.restorable.status).toBe('nextAction');
        expect(result.restorable._id).toBe(item._id);
    });

    it('restoreTrashedRoutineItem puts the pending item back with a fresh updatedTs', async () => {
        const previous = buildRoutine();
        const next = buildRoutine({ rrule: 'FREQ=DAILY;UNTIL=20260101T235959Z' });
        await db.put('routines', next);
        const item = buildOpenItem();
        await db.put('items', item);
        const result = await syncOpenItemAfterNextActionEdit(db, { previous, next, scheduleChanged: true });
        if (result.outcome !== 'trashedExhausted') throw new Error('expected trashedExhausted outcome');

        await restoreTrashedRoutineItem(db, result.restorable);
        const stored = await db.get('items', 'item-1');
        expect(stored?.status).toBe('nextAction');
        expect(stored?.expectedBy).toBe(item.expectedBy);
        // Fresh updatedTs so LWW beats the trash op on other devices.
        expect(stored && stored.updatedTs > item.updatedTs).toBe(true);
    });
});

describe('persistRoutineTextEdit — autosave content sync', () => {
    it('propagates a title/notes commit to a clean open item', async () => {
        const live = buildRoutine();
        await db.put('routines', live);
        await db.put('items', buildOpenItem());

        await persistRoutineTextEdit(db, live, { title: 'Water all plants', notes: 'north window too' });

        const storedRoutine = await db.get('routines', 'routine-1');
        expect(storedRoutine?.title).toBe('Water all plants');
        expect(storedRoutine?.template.notes).toBe('north window too');
        const storedItem = await db.get('items', 'item-1');
        expect(storedItem?.title).toBe('Water all plants');
        expect(storedItem?.notes).toBe('north window too');
    });

    it('chains a debounced burst — each commit baselines on the previously persisted routine', async () => {
        const live = buildRoutine();
        await db.put('routines', live);
        await db.put('items', buildOpenItem());

        const afterFirst = await persistRoutineTextEdit(db, live, { title: 'Water plant', notes: '' });
        await persistRoutineTextEdit(db, afterFirst, { title: 'Water planters', notes: '' });

        const storedItem = await db.get('items', 'item-1');
        expect(storedItem?.title).toBe('Water planters');
    });

    it('preserves an item title hand-renamed between burst commits', async () => {
        const live = buildRoutine();
        await db.put('routines', live);
        await db.put('items', buildOpenItem());

        const afterFirst = await persistRoutineTextEdit(db, live, { title: 'Water plant', notes: '' });
        const midBurst = await db.get('items', 'item-1');
        if (!midBurst) throw new Error('expected the open item');
        await db.put('items', { ...midBurst, title: 'My special watering task' });

        await persistRoutineTextEdit(db, afterFirst, { title: 'Water planters', notes: '' });

        const storedItem = await db.get('items', 'item-1');
        expect(storedItem?.title).toBe('My special watering task');
    });
});

describe('syncOpenItemAfterNextActionEdit — schedule flag with stable date', () => {
    it('still writes the content merge when the recomputed date equals the current one', async () => {
        const previous = buildRoutine();
        // rrule text changes (canonical caller would flag scheduleChanged) but daily recompute
        // lands on today — the item already sits on today, so only content actually moves.
        const next = buildRoutine({ rrule: 'FREQ=DAILY;INTERVAL=1;WKST=MO', template: { energy: 'high' } });
        await db.put('items', buildOpenItem({ expectedBy: '2026-07-06', ignoreBefore: '2026-07-06' }));

        const result = await syncOpenItemAfterNextActionEdit(db, { previous, next, scheduleChanged: true });
        expect(result.outcome).toBe('updated');
        const stored = await db.get('items', 'item-1');
        expect(stored?.energy).toBe('high');
        expect(stored?.expectedBy).toBe('2026-07-06');
    });
});
