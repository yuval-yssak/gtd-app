import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import type { MyDB, StoredRoutine } from '../types/MyDB';
import { deleteRoutineById, putRoutine } from './routineHelpers';
import {
    createFirstRoutineItem,
    generateCalendarItemsToHorizon,
    isFutureStartDate,
    trashAllOpenItemsForRoutine,
    trashFutureItemsFromDate,
} from './routineItemHelpers';
import { queueSyncOp } from './syncHelpers';

function nowIso(): string {
    return dayjs().toISOString();
}

export type NewRoutineFields = Omit<StoredRoutine, '_id' | 'createdTs' | 'updatedTs'>;

export async function createRoutine(db: IDBPDatabase<MyDB>, fields: NewRoutineFields): Promise<StoredRoutine> {
    const now = nowIso();
    const routine: StoredRoutine = { ...fields, _id: crypto.randomUUID(), createdTs: now, updatedTs: now };
    await putRoutine(db, routine);
    await queueSyncOp(db, { opType: 'create', entityType: 'routine', entityId: routine._id, snapshot: routine, userId: routine.userId });
    return routine;
}

/**
 * Create a routine and seed its first item(s) — calendar routines fill the generation horizon,
 * nextAction routines seed one item unless the startDate is in the future (the boot-tick
 * materialises those on the day). Seeding errors are logged, not thrown: a failed first item must
 * never roll back a successfully persisted routine. Shared by the routine editor's create path
 * and the clarify-to-routine flow so both create routines identically.
 */
export async function createRoutineWithFirstItems(db: IDBPDatabase<MyDB>, fields: NewRoutineFields): Promise<StoredRoutine> {
    const created = await createRoutine(db, fields);
    try {
        await seedFirstItems(db, created);
    } catch (err) {
        console.error('[routine] failed to create items:', err);
    }
    return created;
}

async function seedFirstItems(db: IDBPDatabase<MyDB>, routine: StoredRoutine): Promise<void> {
    if (routine.routineType === 'calendar') {
        await generateCalendarItemsToHorizon(db, routine.userId, routine);
        return;
    }
    if (isFutureStartDate(routine.startDate)) {
        return;
    }
    await createFirstRoutineItem(db, routine.userId, routine);
}

export async function updateRoutine(db: IDBPDatabase<MyDB>, routine: StoredRoutine): Promise<StoredRoutine> {
    const updated: StoredRoutine = { ...routine, updatedTs: nowIso() };
    await putRoutine(db, updated);
    await queueSyncOp(db, { opType: 'update', entityType: 'routine', entityId: updated._id, snapshot: updated, userId: updated.userId });
    return updated;
}

export async function removeRoutine(db: IDBPDatabase<MyDB>, routineId: string): Promise<void> {
    // Read the owning userId before delete so the queued delete op is scoped to the right account.
    const existing = await db.get('routines', routineId);
    // Trash open items BEFORE deleting the routine row — mirrors pauseRoutine's ordering so a
    // crash mid-operation can't leave an orphaned item with no trace the cascade was attempted.
    if (existing?.userId) {
        await trashAllOpenItemsForRoutine(db, existing.userId, routineId);
    }
    await deleteRoutineById(db, routineId);
    await queueSyncOp(db, {
        opType: 'delete',
        entityType: 'routine',
        entityId: routineId,
        snapshot: null,
        ...(existing?.userId ? { userId: existing.userId } : {}),
    });
}

/**
 * Pause a routine: flips `active=false` and trashes every future open item tied to it. Past-due
 * open items are intentionally left alone — the pause invariant is forward-looking, not a cleanup
 * of the user's backlog. Server-side pushback (handleRoutinePush) detects the active-flag transition
 * and caps the GCal master with UNTIL for calendar routines; nothing extra happens for nextAction.
 */
export async function pauseRoutine(db: IDBPDatabase<MyDB>, userId: string, routine: StoredRoutine): Promise<StoredRoutine> {
    const todayStr = dayjs().startOf('day').format('YYYY-MM-DD');
    // Trash future open items BEFORE flipping active=false so horizon-generator guards that early-
    // return on !active don't accidentally leave items behind on a different device's next sync.
    await trashFutureItemsFromDate(db, userId, routine._id, todayStr);
    return updateRoutine(db, { ...routine, active: false });
}
