import { randomUUID } from 'node:crypto';
import operationsDAO from '../dataAccess/operationsDAO.js';
import type { ItemInterface, OperationInterface, RoutineInterface } from '../types/entities.js';

/** Records a server-originated operation so all devices learn about the change via sync pull. Returns the created operation. */
export async function recordOperation(
    userId: string,
    op: { entityType: 'item' | 'routine'; entityId: string; snapshot: ItemInterface | RoutineInterface; opType: 'create' | 'update'; now: string },
): Promise<OperationInterface> {
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
