import { randomUUID } from 'node:crypto';
import dayjs from 'dayjs';
import operationsDAO from '../dataAccess/operationsDAO.js';
import { type ValidationFailure, validateOperation } from '../schemas/operations/index.js';
import type { EntitySnapshot, EntityType, OperationInterface, OpType, RsvpOpPayload } from '../types/entities.js';
import { applyEntityOp, hydrateRoutineDeleteSnapshots } from './applyEntityOp.js';
import { buildCalendarProvider } from './buildCalendarProvider.js';
import { type NotifyChangeOptions, notifyChange, notifyChanges } from './notifyChange.js';
import { replayRsvpOp } from './rsvpReplay.js';

export interface RawOperation {
    entityType: EntityType;
    entityId: string;
    opType: OpType;
    snapshot: EntitySnapshot | null;
    /**
     * Optional GCal sidecar carrying the user's SendUpdatesDialog choice. Forwarded onto the
     * persisted op so `maybePushToGCal` can pass `sendUpdates` through to the provider call.
     * Absent → pushback defaults to `'none'`.
     */
    gcalMeta?: { sendUpdates: 'all' | 'none' };
    /**
     * RSVP payload. Required when `opType === 'rsvp'`, absent otherwise. The replay path in
     * `rsvpReplay.ts` reads this off the persisted op to drive the GCal `events.patch` call.
     */
    rsvp?: RsvpOpPayload;
}

export interface ApplyOptions {
    /** Stamp written into `Operation.deviceId`. `/sync/push` passes the client deviceId; public API passes `api:<tokenId>`. */
    deviceId: string;
    /** Strict mode: if validation fails, throw `OperationValidationError` instead of logging. */
    strict?: boolean;
    /** Override timestamp (used in tests / batch flows where every op shares one wall-clock). */
    now?: string;
    /**
     * Skip the GCal pushback leg of `notifyChange`. Passed by callers that already managed the
     * GCal side-effect inline (e.g. cross-account calendar-item reassign, where create-on-target
     * + delete-on-source are driven directly by `moveItemAcrossCalendars`). SSE / web push /
     * webhook fan-out still fire — only `maybePushToGCal` is suppressed.
     */
    suppressGCalPushback?: boolean;
}

/**
 * Thrown by `applyAndPublishOperation` (in strict mode) when a raw op fails Zod validation or the
 * status→field matrix. Caller is expected to map this to an HTTP 400 with a structured payload.
 */
export class OperationValidationError extends Error {
    readonly failure: ValidationFailure;
    constructor(failure: ValidationFailure) {
        super(failure.message);
        this.name = 'OperationValidationError';
        this.failure = failure;
    }
}

/**
 * Single shared apply pipeline. Both `/sync/push` and every `/v1/*` write route flow through here
 * so the contract validation, persistence, op log, and notification fan-out can never drift.
 *
 * Pipeline:
 *   1. Validate (Zod + status×field matrix). Permissive by default; `strict: true` throws.
 *   2. Build server `Operation` (assign _id, ts, server-authoritative user, deviceId).
 *   3. Hydrate routine-delete snapshots from DB (so the GCal cascade has the pre-delete state).
 *   4. `applyEntityOp` — last-write-wins persist into the target collection.
 *   5. Insert the op into the operations collection.
 *   6. `notifyChange` — SSE + web push + GCal pushback + webhook fan-out.
 *
 * Returns the persisted operation.
 */
export async function applyAndPublishOperation(userId: string, raw: RawOperation, opts: ApplyOptions): Promise<OperationInterface> {
    // Step 1 — validation. Logged in permissive mode so the audit script (and runtime warnings)
    // surface client violations before strict-mode is flipped.
    if (raw.opType !== 'delete' && raw.snapshot) {
        const validation = validateOperation(raw);
        if (!validation.ok) {
            if (opts.strict) {
                throw new OperationValidationError(validation);
            }
            console.warn('[apply-op] permissive-mode validation failure', {
                code: validation.code,
                message: validation.message,
                entityType: raw.entityType,
                opType: raw.opType,
                entityId: raw.entityId,
                ...(validation.code === 'status_field_violation' ? { extra: validation.extra } : {}),
            });
        }
    }

    // Step 2 — server-authoritative op. Strip any caller-supplied user from the snapshot and stamp
    // ours. The misroute guard in `/sync/push` rejects mismatches up-front; we re-stamp here to be
    // defensive.
    const now = opts.now ?? dayjs().toISOString();
    const op: OperationInterface = {
        _id: randomUUID(),
        user: userId,
        deviceId: opts.deviceId,
        ts: now,
        entityType: raw.entityType,
        entityId: raw.entityId,
        opType: raw.opType,
        snapshot: raw.snapshot ? ({ ...raw.snapshot, user: userId } as EntitySnapshot) : null,
        ...(raw.gcalMeta ? { gcalMeta: raw.gcalMeta } : {}),
        ...(raw.rsvp ? { rsvp: raw.rsvp } : {}),
    };

    // Step 3 — routine-delete snapshot hydration. Mutates op.snapshot in place.
    await hydrateRoutineDeleteSnapshots(userId, [op]);

    // Steps 4 + 5 — persist + log. Apply first so a failure in `applyEntityOp` leaves no op in
    // the log; otherwise other devices would replay an op the server's collections never saw.
    // (The batch path below runs these in parallel as an accepted compromise inherited from the
    // `/sync/push` throughput target — single-batch ops should never target the same entityId.)
    await applyEntityOp(userId, op);
    await operationsDAO.insertOne(op);

    // Step 5b — RSVP replay (offline-first). For `opType: 'rsvp'` ops the GCal push is part of
    // the contract: we await it so the persisted op row can carry `syncFailed` / `failureReason`
    // before the response goes out. Online callers (the dedicated /rsvp endpoint) hit a separate
    // sync path; this branch fires only for ops replayed via /sync/push.
    if (op.opType === 'rsvp') {
        await replayRsvpOp(userId, op, buildCalendarProvider);
    }

    // Step 6 — fan-out. Awaiting only the in-process synchronous legs (SSE + push); GCal +
    // webhooks are fire-and-forget under the hood.
    const notifyOpts: NotifyChangeOptions = {
        ...(opts.deviceId.startsWith('api:') ? {} : { excludeDeviceId: opts.deviceId }),
        ...(opts.suppressGCalPushback ? { suppressGCalPushback: true } : {}),
    };
    await notifyChange(op, notifyOpts);

    return op;
}

/**
 * Batch variant — `/sync/push` receives an array of client ops in one request. Validates each,
 * builds server ops, hydrates routine deletes, persists, and fans out once.
 *
 * Permissive mode: validation failures are logged per-op and the batch proceeds. The audit
 * script + this log feed Phase 1 step 8.
 *
 * Strict mode (post-flip): the first failing op aborts the whole batch — returned as
 * `OperationValidationError`. No partial application: nothing is persisted on failure.
 */
export async function applyAndPublishOperations(userId: string, raws: RawOperation[], opts: ApplyOptions): Promise<OperationInterface[]> {
    if (!raws.length) {
        return [];
    }

    // Validate all up front so strict-mode rejects the whole batch atomically.
    if (opts.strict) {
        for (const raw of raws) {
            if (raw.opType === 'delete' || !raw.snapshot) {
                continue;
            }
            const validation = validateOperation(raw);
            if (!validation.ok) {
                throw new OperationValidationError(validation);
            }
        }
    } else {
        for (const raw of raws) {
            if (raw.opType === 'delete' || !raw.snapshot) {
                continue;
            }
            const validation = validateOperation(raw);
            if (!validation.ok) {
                console.warn('[apply-op] permissive-mode validation failure', {
                    code: validation.code,
                    message: validation.message,
                    entityType: raw.entityType,
                    opType: raw.opType,
                    entityId: raw.entityId,
                    ...(validation.code === 'status_field_violation' ? { extra: validation.extra } : {}),
                });
            }
        }
    }

    const now = opts.now ?? dayjs().toISOString();
    const ops: OperationInterface[] = raws.map((raw) => ({
        _id: randomUUID(),
        user: userId,
        deviceId: opts.deviceId,
        ts: now,
        entityType: raw.entityType,
        entityId: raw.entityId,
        opType: raw.opType,
        snapshot: raw.snapshot ? ({ ...raw.snapshot, user: userId } as EntitySnapshot) : null,
        ...(raw.gcalMeta ? { gcalMeta: raw.gcalMeta } : {}),
        ...(raw.rsvp ? { rsvp: raw.rsvp } : {}),
    }));

    // Hydrate routine-delete snapshots before the apply Promise.all races against the deletion.
    await hydrateRoutineDeleteSnapshots(userId, ops);

    await Promise.all([operationsDAO.insertMany(ops), ...ops.map((op) => applyEntityOp(userId, op))]);

    // RSVP replay (offline-first). Awaited in queue order — every RSVP replays so the organizer
    // sees the full history, per plan ("do NOT coalesce queued RSVPs"). Sequential await (not
    // Promise.all) keeps the per-entity ordering deterministic when multiple RSVPs land on the
    // same item from a single flush batch.
    for (const op of ops) {
        if (op.opType === 'rsvp') {
            await replayRsvpOp(userId, op, buildCalendarProvider);
        }
    }

    const notifyOpts: NotifyChangeOptions = {
        ...(opts.deviceId.startsWith('api:') ? {} : { excludeDeviceId: opts.deviceId }),
        ...(opts.suppressGCalPushback ? { suppressGCalPushback: true } : {}),
    };
    await notifyChanges(ops, notifyOpts);

    return ops;
}
