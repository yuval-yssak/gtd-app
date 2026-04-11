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
 */
export async function propagateRoutineNotesToItems(routineId: string, notes: string | undefined, userId: string, now?: string): Promise<OperationInterface[]> {
    const items = await itemsDAO.findArray({ user: userId, routineId, status: 'calendar' });
    if (!items.length) {
        return [];
    }

    const ts = now ?? dayjs().toISOString();
    const ops = await Promise.all(
        items.map(async (item) => {
            const itemId = item._id;
            if (!itemId) {
                return null;
            }
            const updated: ItemInterface = notes ? { ...item, notes, updatedTs: ts } : omitItemNotes({ ...item, updatedTs: ts });
            await itemsDAO.replaceById(itemId, updated);
            return recordOperation(userId, { entityType: 'item', entityId: itemId, snapshot: updated, opType: 'update', now: ts });
        }),
    );
    return ops.filter((op): op is OperationInterface => op !== null);
}
