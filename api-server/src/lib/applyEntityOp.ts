import type AbstractDAO from '../dataAccess/abstractDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import peopleDAO from '../dataAccess/peopleDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import workContextsDAO from '../dataAccess/workContextsDAO.js';
import type { EntitySnapshot, ItemInterface, OperationInterface, OpType, PersonInterface, RoutineInterface, WorkContextInterface } from '../types/entities.js';

/**
 * Persists a single op to its target collection. Last-write-wins on (updatedTs); deletes are
 * scoped by user to ensure a crafted op can't reach across users.
 *
 * Lifted out of `routes/sync.ts` so the new `applyAndPublishOperation` pipeline can drive both
 * `/sync/push` and `/v1/*` writes through the same primitive.
 */
async function applyEntitySnapshotOp<T extends EntitySnapshot>(
    dao: AbstractDAO<T>,
    userId: string,
    entityId: string,
    opType: OpType,
    snapshot: T | null,
): Promise<void> {
    if (opType === 'delete') {
        await dao.deleteByOwner(entityId, userId);
        return;
    }
    if (!snapshot) {
        return;
    }
    const existing = await dao.findByOwnerAndId(entityId, userId);
    if (!existing || existing.updatedTs <= snapshot.updatedTs) {
        await dao.replaceById(entityId, snapshot);
    }
}

export function applyEntityOp(userId: string, op: OperationInterface): Promise<void> {
    const { entityType, entityId, opType, snapshot } = op;
    switch (entityType) {
        case 'item':
            return applyEntitySnapshotOp(itemsDAO, userId, entityId, opType, snapshot as ItemInterface | null);
        case 'routine':
            return applyEntitySnapshotOp(routinesDAO, userId, entityId, opType, snapshot as RoutineInterface | null);
        case 'person':
            return applyEntitySnapshotOp(peopleDAO, userId, entityId, opType, snapshot as PersonInterface | null);
        case 'workContext':
            return applyEntitySnapshotOp(workContextsDAO, userId, entityId, opType, snapshot as WorkContextInterface | null);
    }
}

/**
 * Routine-delete ops ship with `snapshot: null`. To drive the GCal push-back cascade
 * (delete the master recurring event; trash generated calendar items) we need the
 * pre-delete routine state. Mutates each matching op in-place so the same snapshot
 * is both recorded in the ops collection and handed to `maybePushToGCal`.
 *
 * MUST complete before applyEntityOp runs, which hard-deletes the routine — otherwise the
 * lookup races against the deletion and returns null.
 */
export async function hydrateRoutineDeleteSnapshots(userId: string, ops: OperationInterface[]): Promise<void> {
    const targets = ops.filter((op) => op.entityType === 'routine' && op.opType === 'delete' && !op.snapshot);
    if (!targets.length) {
        return;
    }
    await Promise.all(
        targets.map(async (op) => {
            const routine = await routinesDAO.findByOwnerAndId(op.entityId, userId);
            if (routine) {
                op.snapshot = routine;
                return;
            }
            console.warn(`[apply-op] routine ${op.entityId} already deleted — snapshot hydration skipped, cascade will no-op`);
        }),
    );
}
