import type AbstractDAO from '../dataAccess/abstractDAO.js';
import entityMovesDAO, { entityMoveReceiptId } from '../dataAccess/entityMovesDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import { validateOperation } from '../schemas/operations/index.js';
import type { EntitySnapshot, EntityType, OperationInterface } from '../types/entities.js';
import { OperationValidationError, toServerOperation } from './applyOperation.js';
import { notifyChange } from './notifyChange.js';

export interface OwnerMoveParams<S extends EntitySnapshot> {
    entityType: EntityType;
    entityId: string;
    fromUserId: string;
    toUserId: string;
    /** Row state under `fromUserId` before the flip — becomes the delete-leg op snapshot (drives async source-side GCal cleanup). */
    preMoveSnapshot: S;
    /** Target-owner state written by the flip — becomes the create-leg op snapshot (drives async target-side GCal creation). */
    newSnapshot: S;
    deviceId: string;
    now: string;
}

export type OwnerMoveOutcome = 'moved' | 'not-owned';

/**
 * Atomic cross-account owner flip. Entities keep one `_id` in one collection with owner field
 * `user`, so a move is a single `replaceOne({_id, user: fromUserId}, newSnapshot)` — there is no
 * window where the entity exists in neither account (the old delete-op-then-create-op flow could
 * crash between the two legs and lose the entity from BOTH).
 *
 * Sequence: validate target snapshot → atomic flip → insert BOTH op-log legs (delete under
 * fromUserId carrying the pre-move snapshot, then create under toUserId; ordered, delete first)
 * → notify per op.
 *
 * Crash-ordering rationale — flip FIRST, logs after: a crash after the flip but before the log
 * inserts leaves the server's collections correct (entity under the new owner) and a client retry
 * re-derives both log legs via the already-moved idempotency branch in `reassignEntity`. The
 * reverse order (logs first) would let devices replay a move the server never applied — strictly
 * worse, because the op log would then disagree with the ground-truth collections.
 */
export async function applyAndPublishOwnerMove<S extends EntitySnapshot>(dao: AbstractDAO<S>, params: OwnerMoveParams<S>): Promise<OwnerMoveOutcome> {
    const { entityType, entityId, fromUserId, toUserId, preMoveSnapshot, newSnapshot, deviceId, now } = params;
    // Validate BEFORE the flip — a malformed target snapshot must reject the whole move with a
    // structured 400, not leave a half-moved entity. Same Zod + status×field matrix the strict
    // apply pipeline runs; same error type so callers map it to `validation_failed` uniformly.
    const validation = validateOperation({ entityType, entityId, snapshot: newSnapshot, opType: 'create' });
    if (!validation.ok) {
        throw new OperationValidationError(validation);
    }
    // Move receipt BEFORE the flip — a claim of intent, not of applied state. This is the positive
    // provenance the already-moved idempotency branch requires: without it, "present under
    // toUserId" is equally true of an entity toUserId has always owned, and a retry from a caller
    // who never held the row would be answered `alreadyMoved` (forging op legs on both users). A
    // stale receipt from a crash BEFORE the flip is harmless — the entity is still under
    // fromUserId, so a retry takes the normal path, and the receipt only ever unlocks the
    // idempotency branch when the entity actually sits under toUserId.
    await entityMovesDAO.replaceById(entityMoveReceiptId(entityId, fromUserId, toUserId), {
        _id: entityMoveReceiptId(entityId, fromUserId, toUserId),
        entityId,
        entityType,
        fromUserId,
        toUserId,
        ts: now,
    });
    const matched = await dao.replaceByOwner(entityId, fromUserId, newSnapshot);
    if (matched === 0) {
        return 'not-owned';
    }
    const stamp = { deviceId, now };
    const deleteOp = toServerOperation(fromUserId, { entityType, entityId, opType: 'delete', snapshot: preMoveSnapshot }, stamp);
    const createOp = toServerOperation(toUserId, { entityType, entityId, opType: 'create', snapshot: newSnapshot }, stamp);
    // Ordered, delete first — a webhook subscriber on the target must never observe the create
    // before the source channel has the delete.
    await operationsDAO.insertOne(deleteOp);
    await operationsDAO.insertOne(createOp);
    await notifyMoveOps([deleteOp, createOp], deviceId);
    return 'moved';
}

/**
 * Re-emits both op-log legs for a move that already happened — the idempotent retry / crash-heal
 * path. The delete leg carries `snapshot: null` (the pre-move state is unrecoverable and nothing
 * downstream should re-run the source-side GCal cleanup); the create leg carries the entity's
 * CURRENT row under the new owner, so devices converge on ground truth. Safe to emit repeatedly:
 * snapshot ops are last-write-wins idempotent on every client.
 *
 * Deliberately skips `validateOperation`: the create leg's snapshot is the already-persisted
 * server row (ground truth, validated when it was written). Re-validating here would let a
 * later-tightened schema block the crash-heal path for a row that legitimately predates the
 * tightening — the heal must always be able to converge devices on what the server actually holds.
 */
export async function republishOwnerMoveOps(
    identity: { entityType: EntityType; entityId: string; fromUserId: string; toUserId: string },
    currentSnapshot: EntitySnapshot,
    stamp: { deviceId: string; now: string },
): Promise<void> {
    const { entityType, entityId, fromUserId, toUserId } = identity;
    const deleteOp = toServerOperation(fromUserId, { entityType, entityId, opType: 'delete', snapshot: null }, stamp);
    const createOp = toServerOperation(toUserId, { entityType, entityId, opType: 'create', snapshot: currentSnapshot }, stamp);
    await operationsDAO.insertOne(deleteOp);
    await operationsDAO.insertOne(createOp);
    await notifyMoveOps([deleteOp, createOp], stamp.deviceId);
}

/** Shared fan-out for move ops — mirrors the excludeDeviceId convention in `applyAndPublishOperation`. */
async function notifyMoveOps(ops: OperationInterface[], deviceId: string): Promise<void> {
    for (const op of ops) {
        await notifyChange(op, deviceId.startsWith('api:') ? {} : { excludeDeviceId: deviceId });
    }
}
