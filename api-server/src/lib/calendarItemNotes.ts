import dayjs from 'dayjs';
import itemsDAO from '../dataAccess/itemsDAO.js';
import type { ItemInterface, OperationInterface } from '../types/entities.js';
import { recordOperation } from './operationHelpers.js';

/** Strips `notes` from an item (satisfies exactOptionalPropertyTypes — can't set `notes: undefined`). */
export function omitItemNotes(item: ItemInterface): ItemInterface {
    const { notes: _, ...rest } = item;
    return rest;
}

/**
 * Propagates routine template.notes to all future calendar items belonging to the routine.
 * Returns the recorded operations so callers can append to their own ops list if needed.
 *
 * This runs on the fire-and-forget pushback leg, concurrently with the awaited PATCH item
 * regeneration — so it must be no-op safe: items already carrying the target notes are skipped
 * (an unconditional rewrite emitted an identical op per item on every webhook fire), and the
 * write is a field-scoped update conditional on `status: 'calendar'` rather than a full-snapshot
 * replace (replacing a pre-read snapshot resurrected items the regen had just trashed).
 */
export async function propagateRoutineNotesToItems(routineId: string, notes: string | undefined, userId: string, now?: string): Promise<OperationInterface[]> {
    // Normalize '' → undefined on both sides: a cleared GCal description and an absent one must compare equal.
    const targetNotes = notes || undefined;
    const items = await itemsDAO.findArray({ user: userId, routineId, status: 'calendar' });
    const staleItems = items.filter((item) => (item.notes || undefined) !== targetNotes);
    if (!staleItems.length) {
        return [];
    }

    const ts = now ?? dayjs().toISOString();
    const ops = await Promise.all(staleItems.map((item) => applyNotesToLiveItem(item, targetNotes, userId, ts)));
    return ops.filter((op): op is OperationInterface => op !== null);
}

/** Stamps `notes` onto one still-live calendar item and records the op; returns null when the item was concurrently trashed/re-homed. */
async function applyNotesToLiveItem(item: ItemInterface, notes: string | undefined, userId: string, ts: string): Promise<OperationInterface | null> {
    const itemId = item._id;
    if (!itemId) {
        return null;
    }
    // `'' as const`: Mongo's UpdateFilter narrows $unset values to true | '' | 1, but the union with the
    // $set branch widens the literal back to string — the const assertion keeps the driver typing intact.
    const update = notes ? { $set: { notes, updatedTs: ts } } : { $set: { updatedTs: ts }, $unset: { notes: '' as const } };
    const result = await itemsDAO.updateOne({ _id: itemId, user: userId, status: 'calendar' }, update);
    if (result.modifiedCount === 0) {
        return null;
    }
    const updated: ItemInterface = notes ? { ...item, notes, updatedTs: ts } : omitItemNotes({ ...item, updatedTs: ts });
    return recordOperation(userId, { entityType: 'item', entityId: itemId, snapshot: updated, opType: 'update', now: ts });
}
