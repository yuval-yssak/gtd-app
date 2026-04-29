import { randomUUID } from 'node:crypto';
import operationsDAO from '../dataAccess/operationsDAO.js';
import type { EntitySnapshot, OperationInterface } from '../types/entities.js';

// Discriminated on opType: create/update require a full snapshot; delete carries null.
// `entityType` widened to all four entity types so the reassign endpoint (which moves
// people / workContexts as well as items / routines) can publish ops without a parallel helper.
type RecordOperationInput =
    | { entityType: 'item' | 'routine' | 'person' | 'workContext'; entityId: string; snapshot: EntitySnapshot; opType: 'create' | 'update'; now: string }
    | { entityType: 'item' | 'routine' | 'person' | 'workContext'; entityId: string; snapshot: null; opType: 'delete'; now: string };

/** Records a server-originated operation so all devices learn about the change via sync pull. Returns the created operation. */
export async function recordOperation(userId: string, op: RecordOperationInput): Promise<OperationInterface> {
    // deviceId: 'server' — server-originated ops have no real device; the sync pull
    // mechanism filters by ts, not deviceId, so this value is just a marker.
    const operation: OperationInterface = {
        _id: randomUUID(),
        user: userId,
        deviceId: 'server',
        ts: op.now,
        entityType: op.entityType,
        entityId: op.entityId,
        opType: op.opType,
        snapshot: op.snapshot,
    };
    await operationsDAO.insertOne(operation);
    return operation;
}
