import type { IDBPDatabase } from 'idb';
import type { MyDB, StoredItem, StoredRoutine } from '../types/MyDB';
import { clarifyToTrash, removeItem, updateItem } from './itemMutations';
import { deleteRoutineById } from './routineHelpers';
import { createRoutineWithFirstItems, type NewRoutineFields } from './routineMutations';
import { queueSyncOp } from './syncHelpers';

/**
 * Clarify-to-routine mutations: an inbox item is consumed (trashed) and reborn as a recurring
 * routine. Lives in its own module because it spans both entity families — item disposal on one
 * side, routine creation on the other.
 */

/** Routine payload for clarify-to-routine — everything but the owner/active flags, which the
 *  clarified item dictates (its userId; always born active). */
export type ClarifiedRoutineFields = Omit<NewRoutineFields, 'userId' | 'active'>;

/**
 * Clarify an inbox item into a routine: create the routine (with its seeded first items) under the
 * item's owner, then trash the item — the routine absorbs its title/notes, so the capture is
 * consumed rather than kept. Routine first so a failed create never costs the user their item.
 */
export async function clarifyToRoutine(
    db: IDBPDatabase<MyDB>,
    item: StoredItem,
    fields: ClarifiedRoutineFields,
): Promise<{ routine: StoredRoutine; trashedItem: StoredItem }> {
    const routine = await createRoutineWithFirstItems(db, { ...fields, userId: item.userId, active: true });
    const trashedItem = await clarifyToTrash(db, item);
    return { routine, trashedItem };
}

/**
 * Undo for clarify-to-routine: hard-delete the just-created routine and every item it generated
 * (they never meaningfully existed — trashing them would leave confusing rows), then restore the
 * item's pre-clarify snapshot. The delete ops cascade server-side exactly like a routines-page
 * delete, so a pushed GCal series is cleaned up too.
 */
export async function undoClarifyToRoutine(db: IDBPDatabase<MyDB>, routine: StoredRoutine, preClarifyItem: StoredItem): Promise<void> {
    await hardDeleteRoutineWithGeneratedItems(db, routine);
    await updateItem(db, preClarifyItem);
}

/**
 * Sibling of `removeRoutine` (routineMutations.ts) — same routine-delete op protocol, but the
 * generated items are HARD-deleted instead of trashed (undo semantics: they never existed).
 * Kept separate rather than parameterising `removeRoutine` because importing `removeItem` there
 * would add an itemMutations ↔ routineMutations module cycle; if `removeRoutine`'s op shape
 * changes, this must change with it.
 */
async function hardDeleteRoutineWithGeneratedItems(db: IDBPDatabase<MyDB>, routine: StoredRoutine): Promise<void> {
    const items = await db.getAllFromIndex('items', 'userId', routine.userId);
    const generated = items.filter((candidate) => candidate.routineId === routine._id);
    // Items go first so their delete ops reach the server while the routine row still exists —
    // the server's per-item GCal cascade checks the owning routine before touching the series.
    for (const generatedItem of generated) {
        await removeItem(db, generatedItem._id);
    }
    await deleteRoutineById(db, routine._id);
    await queueSyncOp(db, { opType: 'delete', entityType: 'routine', entityId: routine._id, snapshot: null, userId: routine.userId });
}
