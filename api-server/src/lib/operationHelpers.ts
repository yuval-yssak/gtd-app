import { randomUUID } from 'node:crypto';
import dayjs from 'dayjs';
import operationsDAO from '../dataAccess/operationsDAO.js';
import type { EntitySnapshot, EntityType, OperationInterface, RsvpOpPayload } from '../types/entities.js';

// Discriminated on opType: create/update require a full snapshot; delete carries null;
// rsvp carries a sidecar payload (no snapshot — replay reads the item by id).
// `entityType` widened to every entity type so the reassign endpoint (which moves
// people / workContexts as well as items / routines) can publish ops without a parallel helper.
type RecordOperationInput =
    | {
          entityType: EntityType;
          entityId: string;
          snapshot: EntitySnapshot;
          opType: 'create' | 'update';
          now: string;
          deviceId?: string;
      }
    | {
          entityType: EntityType;
          entityId: string;
          snapshot: null;
          opType: 'delete';
          now: string;
          deviceId?: string;
      }
    | {
          entityType: 'item';
          entityId: string;
          snapshot: null;
          opType: 'rsvp';
          rsvp: RsvpOpPayload;
          now: string;
          deviceId?: string;
      };

/**
 * Tolerance before a snapshot's `updatedTs` ahead of the server clock is considered suspect.
 * Generous because callers pass a `now` captured at the start of a sync run — a long GCal sweep
 * can legitimately record ops minutes after its clock was taken.
 */
const FUTURE_UPDATED_TS_TOLERANCE_MINUTES = 5;

/**
 * Warn-only sanity check: server-originated writers must stamp `updatedTs` from the sync clock
 * (`ctx.now` / server now), never from a caller- or GCal-supplied value. A future stamp poisons
 * LWW on every device until it passes (see `clampUpdatedTs` in applyOperation.ts). No clamping
 * here — recordOperation callers have already written the collection themselves, and some
 * deliberately record snapshots meant to lose LWW. A malformed `updatedTs` is deliberately not
 * warned (dayjs(invalid).isAfter(...) is false) — Zod owns shape validation upstream.
 * Exported for unit tests.
 */
export function warnOnFutureUpdatedTs(op: RecordOperationInput): void {
    if (!op.snapshot) {
        return;
    }
    if (dayjs(op.snapshot.updatedTs).isAfter(dayjs(op.now).add(FUTURE_UPDATED_TS_TOLERANCE_MINUTES, 'minute'))) {
        console.warn(`[record-op] snapshot.updatedTs ${op.snapshot.updatedTs} is ahead of server now ${op.now} | entity=${op.entityId}`);
    }
}

/**
 * Records a server-originated operation so all devices learn about the change via sync pull.
 * `deviceId` defaults to 'server' for ops with no real originating device (calendar webhook,
 * routine generator, etc.). The public API passes `api:<tokenId>` so the device value reflects
 * which integration drove the change. Returns the created operation.
 */
export async function recordOperation(userId: string, op: RecordOperationInput): Promise<OperationInterface> {
    warnOnFutureUpdatedTs(op);
    const operation: OperationInterface = {
        _id: randomUUID(),
        user: userId,
        deviceId: op.deviceId ?? 'server',
        ts: op.now,
        entityType: op.entityType,
        entityId: op.entityId,
        opType: op.opType,
        snapshot: op.snapshot,
        // RSVP ops carry their payload sidecar — `snapshot` stays null because replay reads the
        // current item by id rather than reconstructing from the op log.
        ...(op.opType === 'rsvp' ? { rsvp: op.rsvp } : {}),
    };
    await operationsDAO.insertOne(operation);
    return operation;
}
