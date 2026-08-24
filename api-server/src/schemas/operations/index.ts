import type { z } from 'zod';
import { z as zod } from 'zod';
import type { EntitySnapshot, EntityType, OpType } from '../../types/entities.js';
import { assertStatusFieldRules, ItemCreateSchema, ItemDeleteSchema, ItemRsvpSchema, ItemUpdateSchema } from './item.js';
import { PersonCreateSchema, PersonDeleteSchema, PersonUpdateSchema } from './person.js';
import { ReviewInboxCreateSchema, ReviewInboxDeleteSchema, ReviewInboxUpdateSchema } from './reviewInbox.js';
import { RoutineCreateSchema, RoutineDeleteSchema, RoutineUpdateSchema } from './routine.js';
import { WorkContextCreateSchema, WorkContextDeleteSchema, WorkContextUpdateSchema } from './workContext.js';

export type { ItemSnapshot, StatusFieldViolation } from './item.js';
export { assertStatusFieldRules, ItemSnapshotSchema, RsvpOpPayloadSchema, stripDisallowedStatusFields } from './item.js';
export { PersonSnapshotSchema } from './person.js';
export { ReviewInboxSnapshotSchema } from './reviewInbox.js';
export { RoutineSnapshotSchema } from './routine.js';
export { WorkContextSnapshotSchema } from './workContext.js';

// Discriminated union over (entityType, opType) so a malformed op gets a structured Zod error
// pointing at the offending field. We discriminate manually because Zod's discriminatedUnion
// only supports a single key and we want an exact (entityType, opType) match.
// Item arms include the rsvp opType (item-only — no other entity carries an rsvp shape).
export const OperationSchema = zod.discriminatedUnion('entityType', [
    zod.discriminatedUnion('opType', [ItemCreateSchema, ItemUpdateSchema, ItemDeleteSchema, ItemRsvpSchema]),
    zod.discriminatedUnion('opType', [RoutineCreateSchema, RoutineUpdateSchema, RoutineDeleteSchema]),
    zod.discriminatedUnion('opType', [PersonCreateSchema, PersonUpdateSchema, PersonDeleteSchema]),
    zod.discriminatedUnion('opType', [WorkContextCreateSchema, WorkContextUpdateSchema, WorkContextDeleteSchema]),
    zod.discriminatedUnion('opType', [ReviewInboxCreateSchema, ReviewInboxUpdateSchema, ReviewInboxDeleteSchema]),
]);

export type ValidatedOperation = z.infer<typeof OperationSchema>;

// Snapshot returned to callers is widened to EntitySnapshot so downstream apply code, which is
// already typed against the shared interfaces, doesn't need to discriminate on the Zod-inferred
// union. Validation has already proved structural conformance — this is a width-only widening.
export interface ValidatedOpResult {
    entityType: EntityType;
    entityId: string;
    opType: OpType;
    snapshot: EntitySnapshot | null;
}

export type ValidationFailure = {
    ok: false;
    code: 'invalid_operation' | 'status_field_violation';
    message: string;
    path?: ReadonlyArray<string | number>;
    /** Present when `code === 'status_field_violation'`. Pinpoints the offending matrix cell. */
    extra?: { status: string; field: string };
};

export type ValidationOutcome = { ok: true; op: ValidatedOpResult } | ValidationFailure;

/**
 * Validates a raw operation payload. Returns the validated op or a structured failure. Failures
 * carry enough metadata for the audit script to bucket violations and for `/sync/push` to surface
 * a precise 400 response once strict-mode is flipped on.
 */
export function validateOperation(raw: unknown): ValidationOutcome {
    const parsed = OperationSchema.safeParse(raw);
    if (!parsed.success) {
        const first = parsed.error.issues[0];
        const path = first?.path?.filter((segment): segment is string | number => typeof segment === 'string' || typeof segment === 'number');
        return {
            ok: false,
            code: 'invalid_operation',
            message: first?.message ?? 'invalid operation',
            ...(path?.length ? { path } : {}),
        };
    }
    const op = parsed.data;
    // status×field matrix only applies to create/update ops carrying a snapshot — rsvp ops have
    // snapshot:null (their payload is validated by RsvpOpPayloadSchema as part of the discriminator).
    if (op.entityType === 'item' && op.opType !== 'delete' && op.opType !== 'rsvp') {
        const violation = assertStatusFieldRules(op.snapshot);
        if (violation) {
            return {
                ok: false,
                code: 'status_field_violation',
                message: violation.message,
                extra: { status: violation.status, field: violation.field },
            };
        }
    }
    // Snapshot is already typed by Zod; widen to EntitySnapshot to keep callers
    // independent of the Zod-inferred shape.
    return {
        ok: true,
        op: {
            entityType: op.entityType,
            entityId: op.entityId,
            opType: op.opType,
            snapshot: op.snapshot as EntitySnapshot | null,
        },
    };
}

/**
 * Validates only the snapshot portion against the entity's schema. Used by composite endpoints
 * that pre-build a snapshot server-side and want to assert conformance before persisting. Mirrors
 * the same status→field matrix check for items.
 */
export function validateSnapshot(entityType: EntityType, entityId: string, snapshot: EntitySnapshot): ValidationOutcome {
    return validateOperation({ entityType, opType: 'update', entityId, snapshot });
}
