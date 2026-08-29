import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { authenticateBearer, type BearerVariables } from '../../auth/bearerMiddleware.js';
import { authenticatedRateLimit } from '../../auth/rateLimitMiddleware.js';
import { applyAndPublishOperations, OperationValidationError, type RawOperation } from '../../lib/applyOperation.js';
import type { ApiTokenScope, EntityType, OpType } from '../../types/entities.js';

/**
 * Public-API batch endpoint: callers submit a heterogeneous array of primitive ops in one
 * request, and the apply pipeline persists them atomically (under the same Zod-validation +
 * fan-out guarantees as the per-entity write routes).
 *
 * Atomic-with-respect-to-validation: if any op fails Zod or the status×field matrix, the whole
 * batch rejects with 400 before any persist. Atomic-with-respect-to-scope: if the caller's
 * token lacks any of the scopes required by the ops in the batch, the whole batch rejects with
 * 403 *before any* op is persisted. (See `requireScopesForBatch` below.)
 *
 * NOT atomic-with-respect-to-Mongo-failure: same caveat as `/sync/push` — once Zod has validated,
 * `applyAndPublishOperations` issues one Mongo insertMany + per-op replaceById in parallel, and
 * a mid-flight Mongo failure can leave a partial state. This is the established sync model.
 */

interface BatchBody {
    ops?: unknown;
}

const MAX_BATCH_OPS = 500;

type ParsedRawOp = RawOperation;

interface ParsedBatch {
    ops: ParsedRawOp[];
}

type ParseError = { code: 'invalid_body' | 'invalid_ops' | 'too_many_ops' | 'invalid_op_shape' | 'forbidden_field'; message: string };

function parseBatchBody(raw: BatchBody | null): { ok: true; value: ParsedBatch } | { ok: false; error: ParseError } {
    if (!raw || typeof raw !== 'object') {
        return { ok: false, error: { code: 'invalid_body', message: 'request body must be a JSON object' } };
    }
    if (!Array.isArray(raw.ops)) {
        return { ok: false, error: { code: 'invalid_ops', message: 'body.ops must be an array' } };
    }
    if (raw.ops.length === 0) {
        return { ok: false, error: { code: 'invalid_ops', message: 'body.ops must not be empty' } };
    }
    if (raw.ops.length > MAX_BATCH_OPS) {
        return { ok: false, error: { code: 'too_many_ops', message: `batch is capped at ${MAX_BATCH_OPS} ops per request` } };
    }
    const parsed: ParsedRawOp[] = [];
    for (let i = 0; i < raw.ops.length; i++) {
        const op = raw.ops[i];
        if (!op || typeof op !== 'object') {
            return { ok: false, error: { code: 'invalid_op_shape', message: `body.ops[${i}] must be an object` } };
        }
        const shape = parseRawOpShape(op as RawOpBag);
        if (!shape.ok) {
            return { ok: false, error: { code: shape.code ?? 'invalid_op_shape', message: `body.ops[${i}]: ${shape.message}` } };
        }
        parsed.push(shape.value);
    }
    return { ok: true, value: { ops: parsed } };
}

// 'reviewInbox' is deliberately excluded: the entity is sync-only for now (no public /v1 or MCP
// surface). Widening this set also requires a scope decision in scopeForOp — today its fallback
// would mislabel a reviewInbox op as requiring 'contexts.write'.
const ENTITY_TYPES = new Set<EntityType>(['item', 'routine', 'person', 'workContext']);
const OP_TYPES = new Set<OpType>(['create', 'update', 'delete']);

interface RawOpBag {
    entityType?: unknown;
    opType?: unknown;
    entityId?: unknown;
    snapshot?: unknown;
}

/**
 * Server-managed sync-integrity fields a public batch snapshot may not carry, per entity type.
 * Selection criterion: fields that (a) anchor sync healing / dedupe / relink state — a forged
 * value silently corrupts it or hijacks a unique index — AND (b) are absent from the public read
 * projections (`presentItem` / `presentRoutine`), so an honest caller echoing a public read can
 * never trip this check. The Zod snapshot schemas can't reject them — `/sync/push` legitimately
 * round-trips them — so the check lives at the public route boundary.
 *
 * NOT listed, deliberately:
 * - `updatedTs` / `user`: publicly readable and echoed by the MCP; silently server-overwritten
 *   instead (see `serverStampUpdatedTs` in applyOperation.ts).
 * - `routineId` / `externalId`: legitimate trash-replay and create-dedupe flows carry them.
 * - `routineExceptions` / `lastGeneratedDate` / `splitFromRoutineId`: server-managed, but part of
 *   the public routine projection — a 400 would break every batch update built from a
 *   `gtd_get_routine` echo. PATCH still rejects them; the full-snapshot surface accepts them, the
 *   same trust it extends to `/sync/push`. This is a narrower guarantee than the per-entity
 *   routes' closed allowlists — documented in PUBLIC_API.md.
 */
const BATCH_FORBIDDEN_SNAPSHOT_FIELDS: Partial<Record<EntityType, readonly string[]>> = {
    item: [
        'contentHash',
        'lastPushedToGCalTs',
        'lastSyncedFromGCalTs',
        'lastSyncedNotes',
        'calendarInstanceEventId',
        'cancelledByGCal',
        'lastKnownCalendarEventId',
        'lastKnownCalendarIntegrationId',
        'lastKnownCalendarSyncConfigId',
        'lastKnownCalendarAccountEmail',
    ],
    routine: [
        'lastPushedToGCalTs',
        'lastSyncedFromGCalTs',
        'lastSyncedNotes',
        'retiredByGCal',
        'calendarRebasedEventId',
        'lastKnownCalendarEventId',
        'lastKnownCalendarIntegrationId',
        'lastKnownCalendarSyncConfigId',
        'lastKnownCalendarAccountEmail',
    ],
};

function findForbiddenSnapshotField(entityType: EntityType, snapshot: object): string | undefined {
    return BATCH_FORBIDDEN_SNAPSHOT_FIELDS[entityType]?.find((field) => field in snapshot);
}

type SnapshotShapeError = { ok: false; code?: 'forbidden_field'; message: string };

/** Snapshot-level checks shared by every op shape: forbidden fields + `_id`/`entityId` agreement. */
function checkSnapshotShape(entityType: EntityType, entityId: string, snapshot: object): SnapshotShapeError | null {
    const forbidden = findForbiddenSnapshotField(entityType, snapshot);
    if (forbidden) {
        return { ok: false, code: 'forbidden_field', message: `snapshot.${forbidden} is server-managed and may not be set via the public API` };
    }
    // `replaceById` replaces `{_id: entityId}` with the snapshot verbatim; a diverging
    // snapshot._id would trip Mongo's _id immutability mid-batch (partial write).
    const snapshotId = (snapshot as { _id?: unknown })._id;
    if (snapshotId !== undefined && snapshotId !== entityId) {
        return { ok: false, message: 'snapshot._id must match entityId' };
    }
    return null;
}

function parseRawOpShape(op: RawOpBag): { ok: true; value: ParsedRawOp } | { ok: false; code?: 'forbidden_field'; message: string } {
    const { entityType, opType, entityId, snapshot } = op;
    if (typeof entityType !== 'string' || !ENTITY_TYPES.has(entityType as EntityType)) {
        return { ok: false, message: `entityType must be one of: ${[...ENTITY_TYPES].join(', ')}` };
    }
    if (typeof opType !== 'string' || !OP_TYPES.has(opType as OpType)) {
        return { ok: false, message: `opType must be one of: ${[...OP_TYPES].join(', ')}` };
    }
    // Item hard-deletes are forbidden on the public surface. `opType: 'delete'` physically removes
    // the row (unrecoverable); headless integrations that meant to dispose of an item should trash
    // it instead (POST /v1/items/:id/trash → recoverable soft-delete). Hard-delete stays available
    // to the first-party client via /sync/push for legitimate permanent purges (e.g. routine
    // item cleanup). Routine/person/workContext deletes are unaffected.
    if (entityType === 'item' && opType === 'delete') {
        return {
            ok: false,
            message: 'item hard-delete is not permitted via the public API — use POST /v1/items/:id/trash to soft-delete (recoverable)',
        };
    }
    if (typeof entityId !== 'string' || entityId.trim() === '') {
        return { ok: false, message: 'entityId must be a non-empty string' };
    }
    const trimmedId = entityId.trim();
    // snapshot can be a (caller-supplied) object or null. Detailed shape validation lives in
    // RoutineSnapshotSchema/etc — invoked by applyAndPublishOperations in strict mode below.
    if (snapshot !== null && (typeof snapshot !== 'object' || Array.isArray(snapshot))) {
        return { ok: false, message: 'snapshot must be an object or null' };
    }
    if (snapshot !== null) {
        const snapshotError = checkSnapshotShape(entityType as EntityType, trimmedId, snapshot);
        if (snapshotError) {
            return snapshotError;
        }
    }
    return {
        ok: true,
        value: {
            entityType: entityType as EntityType,
            opType: opType as OpType,
            entityId: trimmedId,
            snapshot: snapshot as ParsedRawOp['snapshot'],
        },
    };
}

/** Maps each (entityType, opType) pair to the scope required to perform it. */
function scopeForOp(op: ParsedRawOp): ApiTokenScope {
    if (op.entityType === 'item') {
        return op.opType === 'create' ? 'items.capture' : 'items.write';
    }
    if (op.entityType === 'routine') {
        return 'routines.write';
    }
    if (op.entityType === 'person') {
        return 'people.write';
    }
    return 'contexts.write';
}

/**
 * Pre-flight middleware that scans the parsed batch, computes the union of scopes the ops need,
 * and 403s before any write if the token is missing any of them. Atomic — never accepts a
 * partial batch.
 */
export function requireScopesForBatch(): MiddlewareHandler<{ Variables: BearerVariables & { batch: ParsedBatch } }> {
    return async (c, next) => {
        const { batch } = c.var;
        const { scopes } = c.var.apiAuth;
        const required = new Set<ApiTokenScope>();
        for (const op of batch.ops) {
            required.add(scopeForOp(op));
        }
        for (const scope of required) {
            if (!scopes.includes(scope)) {
                return c.json(
                    {
                        error: `This token is not permitted to perform this batch. Missing scope: ${scope}.`,
                        code: 'forbidden_scope',
                        requiredScope: scope,
                        allRequiredScopes: [...required],
                    },
                    403,
                );
            }
        }
        await next();
        return;
    };
}

export const v1OperationsRoutes = new Hono<{ Variables: BearerVariables & { batch: ParsedBatch } }>()
    .use('*', authenticateBearer)
    .use('*', authenticatedRateLimit())

    // ── POST /v1/operations/batch ───────────────────────────────────────────
    // The plan called this `/v1/operations:batch` but Hono treats `:` as a path-parameter
    // prefix. Using the slash variant keeps the route declaration straightforward and is
    // semantically equivalent (the `:batch` form exists in some REST conventions to suggest
    // "named action on a collection" — we lose that naming nuance but gain unambiguous routing).
    .post(
        '/operations/batch',
        async (c, next) => {
            // Parse body up-front so the scope-check middleware can read `c.var.batch`.
            const raw = (await c.req.json().catch(() => null)) as BatchBody | null;
            const parsed = parseBatchBody(raw);
            if (!parsed.ok) {
                return c.json({ error: parsed.error.message, code: parsed.error.code }, 400);
            }
            c.set('batch', parsed.value);
            await next();
            return;
        },
        requireScopesForBatch(),
        async (c) => {
            const { userId, tokenId } = c.var.apiAuth;
            const { batch } = c.var;
            try {
                // `serverStampUpdatedTs`: the public surface has no meaningful client clock — a
                // caller-echoed `updatedTs` (e.g. from a stale `gtd_get_item`) would silently lose
                // LWW on every device. Matches the per-entity /v1 routes' server-assigned contract.
                const { ops, outcomes } = await applyAndPublishOperations(userId, batch.ops, {
                    deviceId: `api:${tokenId}`,
                    strict: true,
                    serverStampUpdatedTs: true,
                });
                // Per-op results (additive to the original `{ok, count}` shape): the authoritative
                // server-stamped `updatedTs` and the apply outcome, so agent callers can detect a
                // skipped op (e.g. update-to-deleted → 'skipped_missing') instead of assuming success.
                const results = ops.map((op, index) => {
                    const applyStatus = outcomes[index];
                    if (!applyStatus) {
                        // outcomes is index-aligned with ops by construction; silently reporting
                        // 'applied' on a broken invariant would mask a real failure.
                        throw new Error(`batch outcome missing for op ${index} (${op.entityId})`);
                    }
                    // Only an applied non-delete write has a persisted `updatedTs` to report: a
                    // skipped op's snapshot describes the ATTEMPTED write (the row was never
                    // touched), and a delete op's snapshot is the hydrated PRE-delete row — both
                    // would echo a timestamp that is not the stored state.
                    const landed = applyStatus === 'applied' && op.opType !== 'delete';
                    return {
                        entityType: op.entityType,
                        entityId: op.entityId,
                        opType: op.opType,
                        applyStatus,
                        updatedTs: landed ? (op.snapshot?.updatedTs ?? null) : null,
                    };
                });
                return c.json({ ok: true, count: ops.length, results });
            } catch (err) {
                if (err instanceof OperationValidationError) {
                    return c.json({ error: err.failure.message, code: err.failure.code, ...(err.failure.path ? { path: err.failure.path } : {}) }, 400);
                }
                throw err;
            }
        },
    );
