import { randomUUID } from 'node:crypto';
import operationsDAO from '../dataAccess/operationsDAO.js';
import type { EntitySnapshot, OperationInterface } from '../types/entities.js';

// Discriminated on opType: create/update require a full snapshot; delete carries null.
// `entityType` widened to all four entity types so the reassign endpoint (which moves
// people / workContexts as well as items / routines) can publish ops without a parallel helper.
type RecordOperationInput =
    | {
          entityType: 'item' | 'routine' | 'person' | 'workContext';
          entityId: string;
          snapshot: EntitySnapshot;
          opType: 'create' | 'update';
          now: string;
          deviceId?: string;
      }
    | {
          entityType: 'item' | 'routine' | 'person' | 'workContext';
          entityId: string;
          snapshot: null;
          opType: 'delete';
          now: string;
          deviceId?: string;
      };

/**
 * Records a server-originated operation so all devices learn about the change via sync pull.
 * `deviceId` defaults to 'server' for ops with no real originating device (calendar webhook,
 * routine generator, etc.). The public API passes `api:<tokenId>` so the device value reflects
 * which integration drove the change. Returns the created operation.
 */
export async function recordOperation(userId: string, op: RecordOperationInput): Promise<OperationInterface> {
    const operation: OperationInterface = {
        _id: randomUUID(),
        user: userId,
        deviceId: op.deviceId ?? 'server',
        ts: op.now,
        entityType: op.entityType,
        entityId: op.entityId,
        opType: op.opType,
        snapshot: op.snapshot,
    };
    await operationsDAO.insertOne(operation);
    return operation;
}
