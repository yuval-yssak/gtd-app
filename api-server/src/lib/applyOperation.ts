import { randomUUID } from 'node:crypto';
import dayjs from 'dayjs';
import operationsDAO from '../dataAccess/operationsDAO.js';
import { type ValidationFailure, validateOperation } from '../schemas/operations/index.js';
import type { EntitySnapshot, EntityType, OperationInterface, OpType, RsvpOpPayload } from '../types/entities.js';
import { applyEntityOp, hydrateCalendarDetachSnapshots, hydrateDeleteSnapshots } from './applyEntityOp.js';
import { buildCalendarProvider } from './buildCalendarProvider.js';
import { type NotifyChangeOptions, notifyChange, notifyChanges } from './notifyChange.js';
import { maybeCascadeReferenceRemoval } from './referenceCascades.js';
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
    /**
     * Skip the person/workContext → item reference cascade. Passed by the reassign path on its
     * source-delete leg: the entity is not actually disappearing, it's just changing owner, so
     * stripping references + appending `[person removed: …]` breadcrumbs from referencing items
     * would be wrong. Cross-user references are reported back to the caller via
     * `crossUserReferences` instead. No effect for item/routine deletes (cascade already no-ops).
     */
    suppressReferenceCascade?: boolean;
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
 * Caps a client-supplied `updatedTs` at server time. A device with a fast clock — or an API/MCP
 * caller deriving timestamps from a local date — otherwise stamps `updatedTs` in the future, and
 * every later legitimate edit loses last-write-wins to it: the stale snapshot survives on every
 * device until the poisoned watermark passes (a real incident — a calendar edit was silently
 * dropped for hours). Only the FUTURE side is clamped, deliberately: an old timestamp on an
 * offline edit replayed late is meaningful history and must keep losing LWW to newer edits.
 *
 * This heals the server and every OTHER device, but not the device that wrote the future
 * timestamp — the clamped echo is by construction older than its poisoned local row, so plain
 * LWW rejects it there. The client closes that leg itself: `applyEntityOp` (client
 * `db/syncHelpers.ts`) treats a local `updatedTs` far ahead of the wall clock as a poisoned
 * watermark and lets the inbound snapshot win.
 */
function clampUpdatedTs(snapshot: EntitySnapshot, now: string): EntitySnapshot {
    if (snapshot.updatedTs <= now) {
        return snapshot;
    }
    console.warn(`[apply-op] clamping future updatedTs ${snapshot.updatedTs} -> ${now} | entity=${snapshot._id}`);
    return { ...snapshot, updatedTs: now };
}

/** Server-side provenance stamped onto every persisted op: which device wrote it, and when. */
export interface OpStamp {
    deviceId: string;
    now: string;
}

/**
 * Builds the server-authoritative op from a raw client op: server-assigned `_id` and `ts`, the
 * caller-supplied `user` stripped and re-stamped (the misroute guard in `/sync/push` rejects
 * mismatches up-front; this is defense in depth), and `updatedTs` clamped to server time.
 * Exported for `lib/ownerMove.ts`, which persists its ops directly (no `applyEntityOp` leg —
 * the atomic owner flip already wrote the collection) but must stamp them identically.
 */
export function toServerOperation(userId: string, raw: RawOperation, stamp: OpStamp): OperationInterface {
    const { deviceId, now } = stamp;
    return {
        _id: randomUUID(),
        user: userId,
        deviceId,
        ts: now,
        entityType: raw.entityType,
        entityId: raw.entityId,
        opType: raw.opType,
        snapshot: raw.snapshot ? clampUpdatedTs({ ...raw.snapshot, user: userId } as EntitySnapshot, now) : null,
        ...(raw.gcalMeta ? { gcalMeta: raw.gcalMeta } : {}),
        ...(raw.rsvp ? { rsvp: raw.rsvp } : {}),
    };
}

/**
 * Single shared apply pipeline. Both `/sync/push` and every `/v1/*` write route flow through here
 * so the contract validation, persistence, op log, and notification fan-out can never drift.
 *
 * Pipeline:
 *   1. Validate (Zod + status×field matrix). Permissive by default; `strict: true` throws.
 *   2. Build server `Operation` (assign _id, ts, server-authoritative user, deviceId).
 *   3. Hydrate delete-op snapshots from DB (so the GCal cascade and reference cascades have the
 *      pre-delete state for items, routines, people, and workContexts).
 *   4. `applyEntityOp` — last-write-wins persist into the target collection.
 *   5. Insert the op into the operations collection.
 *   6. `notifyChange` — SSE + web push + GCal pushback + webhook fan-out.
 *
 * Returns the persisted operation.
 */
export async function applyAndPublishOperation(userId: string, raw: RawOperation, opts: ApplyOptions): Promise<OperationInterface> {
    // Step 1 — validation. Logged in permissive mode so the audit script (and runtime warnings)
    // surface client violations before strict-mode is flipped. Validate snapshot-carrying ops AND
    // rsvp ops (rsvp has snapshot:null but carries a structured `rsvp` payload that must conform
    // — without this gate a malformed responseStatus would land on the persisted op and push to GCal).
    if ((raw.opType !== 'delete' && raw.snapshot) || raw.opType === 'rsvp') {
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

    // Step 2 — server-authoritative op.
    const now = opts.now ?? dayjs().toISOString();
    const op = toServerOperation(userId, raw, { deviceId: opts.deviceId, now });

    // Step 3 — delete-op snapshot hydration. Mutates op.snapshot in place so the downstream
    // notify fan-out (GCal pushback, person/workContext reference cascades) has the pre-delete
    // state to work from. Covers items, routines, people, and workContexts uniformly.
    await hydrateDeleteSnapshots(userId, [op]);

    // Step 3b — calendar-detach hydration. An item update that moves a calendar item to an
    // active non-calendar status arrives with the GCal linkage already stripped (status matrix);
    // capture the pre-update row on `op.detachedCalendar` so pushback can remove the GCal event.
    // Must also run before `applyEntityOp` — afterwards the linkage is gone from the DB too.
    await hydrateCalendarDetachSnapshots(userId, [op]);

    // Steps 4 + 5 — persist + log. Apply first so a failure in `applyEntityOp` leaves no op in
    // the log; otherwise other devices would replay an op the server's collections never saw.
    // (The batch path below runs these in parallel as an accepted compromise inherited from the
    // `/sync/push` throughput target — single-batch ops should never target the same entityId.)
    const outcome = await applyEntityOp(userId, op);
    // Quarantine: an update whose row is gone was NOT applied. The op is still inserted (audit
    // trail + SyncIssuesPanel surface) but marked so `/sync/pull` never delivers it — other
    // devices replaying it would resurrect an entity the server deleted or reassigned away.
    if (outcome === 'skipped_missing') {
        markOpNotApplied(op, now);
    }
    await operationsDAO.insertOne(op);
    if (op.notApplied) {
        return op;
    }

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

    // Step 7 — reference cascades. See `runReferenceCascades` for the contract.
    if (!opts.suppressReferenceCascade) {
        await runReferenceCascades([op]);
    }

    return op;
}

/**
 * Stamps the quarantine + failure markers onto an op whose apply was skipped because the target
 * row no longer exists. Mutates in place BEFORE insert so the persisted row and the in-memory op
 * (used for notify filtering) agree. `entity_missing` is deliberately NOT retryable — the entity
 * is not coming back; the SyncIssuesPanel offers Dismiss only.
 */
function buildNotAppliedMarkers(now: string) {
    return {
        syncFailed: true as const,
        failureReason: 'entity_missing' as const,
        failureDetail: 'target entity no longer exists (deleted or reassigned away) — change not applied',
        failedTs: now,
        notApplied: true as const,
    };
}

function markOpNotApplied(op: OperationInterface, now: string): void {
    Object.assign(op, buildNotAppliedMarkers(now));
}

/**
 * Runs the person/workContext → item reference cascade for every op that needs one. Iterating
 * sequentially (not Promise.all) is intentional: two deletes targeting the same items would
 * race on the breadcrumb ordering otherwise, since each cascade re-reads the items collection.
 * Items don't themselves trigger cascades, so this loop is bounded.
 */
async function runReferenceCascades(ops: OperationInterface[]): Promise<void> {
    for (const op of ops) {
        await maybeCascadeReferenceRemoval(op);
    }
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
            // Validate snapshot-carrying ops AND rsvp ops (rsvp's rsvp payload is validated even
            // though snapshot is null). Skip pure deletes (no payload to validate).
            if (raw.opType === 'delete' || (!raw.snapshot && raw.opType !== 'rsvp')) {
                continue;
            }
            const validation = validateOperation(raw);
            if (!validation.ok) {
                throw new OperationValidationError(validation);
            }
        }
    } else {
        for (const raw of raws) {
            // Validate snapshot-carrying ops AND rsvp ops (rsvp's rsvp payload is validated even
            // though snapshot is null). Skip pure deletes (no payload to validate).
            if (raw.opType === 'delete' || (!raw.snapshot && raw.opType !== 'rsvp')) {
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
    const ops: OperationInterface[] = raws.map((raw) => toServerOperation(userId, raw, { deviceId: opts.deviceId, now }));

    // Hydrate delete-op snapshots before the apply Promise.all races against the deletion.
    // Covers items / routines / people / workContexts; needed so the downstream fan-out has the
    // pre-delete state for GCal cancellation and reference cascades.
    await hydrateDeleteSnapshots(userId, ops);

    // Calendar-detach hydration — same before-apply constraint as the delete hydration above:
    // the pre-update row must be captured before the Promise.all below overwrites it.
    await hydrateCalendarDetachSnapshots(userId, ops);

    const [, ...outcomes] = await Promise.all([operationsDAO.insertMany(ops), ...ops.map((op) => applyEntityOp(userId, op))]);

    // Quarantine skipped-missing ops (see the single-op path). Rows were already inserted by the
    // parallel insertMany above, so the markers are written back with an update; the in-memory op
    // is stamped too so the notify/cascade filters below see the same state.
    const quarantined = ops.filter((_, idx) => outcomes[idx] === 'skipped_missing');
    for (const op of quarantined) {
        markOpNotApplied(op, now);
        await operationsDAO.updateOne({ _id: op._id }, { $set: buildNotAppliedMarkers(now) });
    }
    const appliedOps = ops.filter((op) => !op.notApplied);

    // RSVP replay (offline-first). Awaited in queue order — every RSVP replays so the organizer
    // sees the full history, per plan ("do NOT coalesce queued RSVPs"). Sequential await (not
    // Promise.all) keeps the per-entity ordering deterministic when multiple RSVPs land on the
    // same item from a single flush batch.
    for (const op of appliedOps) {
        if (op.opType === 'rsvp') {
            await replayRsvpOp(userId, op, buildCalendarProvider);
        }
    }

    const notifyOpts: NotifyChangeOptions = {
        ...(opts.deviceId.startsWith('api:') ? {} : { excludeDeviceId: opts.deviceId }),
        ...(opts.suppressGCalPushback ? { suppressGCalPushback: true } : {}),
    };
    await notifyChanges(appliedOps, notifyOpts);

    if (!opts.suppressReferenceCascade) {
        await runReferenceCascades(appliedOps);
    }

    return ops;
}
