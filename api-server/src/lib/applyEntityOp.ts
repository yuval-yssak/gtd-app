import type AbstractDAO from '../dataAccess/abstractDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import peopleDAO from '../dataAccess/peopleDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import workContextsDAO from '../dataAccess/workContextsDAO.js';
import type {
    EntitySnapshot,
    EntityType,
    ItemInterface,
    OperationInterface,
    OpType,
    PersonInterface,
    RoutineInterface,
    WorkContextInterface,
} from '../types/entities.js';

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
 * Delete ops ship with `snapshot: null` over the wire (the entity is going away — there's no
 * meaningful post-delete state). But downstream fan-out — GCal pushback, person/workContext
 * reference cascades — needs the pre-delete state to know which GCal event to cancel, which
 * person name to record in a breadcrumb, etc.
 *
 * Hydrates `op.snapshot` in-place by reading the row from its collection before `applyEntityOp`
 * hard-deletes it. MUST run before persistence — otherwise the lookup races and returns null.
 *
 * No-ops for ops that already carry a snapshot (e.g. the client occasionally sends one for
 * audit-trail reasons), and for delete ops whose row was already gone (another device deleted
 * concurrently; the cascade for that op will no-op gracefully).
 */
export async function hydrateDeleteSnapshots(userId: string, ops: OperationInterface[]): Promise<void> {
    const targets = ops.filter((op) => op.opType === 'delete' && !op.snapshot);
    if (!targets.length) {
        return;
    }
    await Promise.all(targets.map((op) => hydrateOne(userId, op)));
}

async function hydrateOne(userId: string, op: OperationInterface): Promise<void> {
    const lookup = pickHydrationLookup(op.entityType);
    if (!lookup) {
        return;
    }
    const snapshot = await lookup(op.entityId, userId);
    if (snapshot) {
        op.snapshot = snapshot;
        return;
    }
    console.warn(`[apply-op] ${op.entityType} ${op.entityId} already deleted — snapshot hydration skipped, cascade will no-op`);
}

// Narrow the DAO surface to just the one method the hydrator needs. `AbstractDAO<T>` is
// invariant in T, so reusing the parent generic to switch concrete DAOs would require an
// unsound cast — exposing just the lookup method sidesteps the variance issue entirely.
type HydrationLookup = (entityId: string, userId: string) => Promise<EntitySnapshot | null>;

function pickHydrationLookup(entityType: EntityType): HydrationLookup | null {
    switch (entityType) {
        case 'item':
            return (id, uid) => itemsDAO.findByOwnerAndId(id, uid);
        case 'routine':
            return (id, uid) => routinesDAO.findByOwnerAndId(id, uid);
        case 'person':
            return (id, uid) => peopleDAO.findByOwnerAndId(id, uid);
        case 'workContext':
            return (id, uid) => workContextsDAO.findByOwnerAndId(id, uid);
    }
}
