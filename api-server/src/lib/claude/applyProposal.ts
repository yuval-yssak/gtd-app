import dayjs from 'dayjs';
import itemsDAO from '../../dataAccess/itemsDAO.js';
import { STATUS_FIELD_MATRIX, STATUS_SPECIFIC_FIELD_LIST } from '../../schemas/operations/item.js';
import type { ItemInterface } from '../../types/entities.js';
import { applyAndPublishOperation, OperationValidationError } from '../applyOperation.js';
import type { ExecuteTokenPayload } from './executeToken.js';
import { PROPOSABLE_ITEM_FIELDS, type ProposableItemField, type ProposedItemPatch } from './proposalSchema.js';

/**
 * Redeems a verified executeToken + the (possibly edited) submitted patch into a single op through
 * the existing write choke-point. Going through `applyAndPublishOperation` means undo, cross-device
 * sync, and GCal pushback all work for free, and the snapshot's `user` is re-stamped server-side.
 */

export type ApplyResult =
    | { ok: true; item: ItemInterface }
    | { ok: false; status: 400 | 404; code: 'item_not_found' | 'execute_token_target_mismatch' | 'invalid_operation' | 'invalid_request'; message: string };

/**
 * Strips status-specific fields that don't belong on the merged item's status, BUT only when they
 * came from the EXISTING row — caller-supplied incompatible fields stay so the strict op validation
 * surfaces a `status_field_violation` 400. This mirrors `items.ts` `sanitizeStaleFields` (the PATCH
 * idiom), NOT the unconditional `sanitizeForStatus` used by POST /complete — silently dropping the
 * caller's intent would mask client/agent bugs.
 */
function sanitizeStaleFields(merged: ItemInterface, callerPatch: ProposedItemPatch): ItemInterface {
    const out: ItemInterface = { ...merged };
    const allowed = STATUS_FIELD_MATRIX[merged.status];
    const patchKeys = callerPatch as unknown as Record<string, unknown>;
    for (const field of STATUS_SPECIFIC_FIELD_LIST) {
        if (allowed.has(field)) {
            continue;
        }
        if (patchKeys[field] === undefined) {
            delete (out as unknown as Record<string, unknown>)[field];
        }
    }
    return out;
}

const PROPOSABLE_FIELD_SET: ReadonlySet<string> = new Set(PROPOSABLE_ITEM_FIELDS);

/** True if every submitted patch field is within both the token's authorized set and the proposable allowlist. */
function patchWithinTarget(patch: ProposedItemPatch, authorizedFields: ProposableItemField[]): boolean {
    const authorized = new Set<string>(authorizedFields);
    return Object.keys(patch).every((field) => PROPOSABLE_FIELD_SET.has(field) && authorized.has(field));
}

export async function applyItemPatch(payload: ExecuteTokenPayload, submittedPatch: ProposedItemPatch, tokenId: string): Promise<ApplyResult> {
    if (typeof submittedPatch !== 'object' || submittedPatch === null) {
        return { ok: false, status: 400, code: 'invalid_request', message: 'A patch object is required.' };
    }
    // An empty patch is a no-op — reject rather than write an op that changes nothing.
    if (Object.keys(submittedPatch).length === 0) {
        return { ok: false, status: 400, code: 'invalid_request', message: 'The patch must contain at least one field to apply.' };
    }
    // Target check (§8.1): editing payload values is fine, but every field must be inside BOTH the
    // token's authorized target AND the proposable allowlist. A field outside either means the
    // target changed (or a non-proposable field was injected) → re-issue required.
    if (!patchWithinTarget(submittedPatch, payload.target.fields)) {
        return {
            ok: false,
            status: 400,
            code: 'execute_token_target_mismatch',
            message: 'The submitted patch changes fields the approval did not authorize. Re-run assist to get a fresh token.',
        };
    }

    // Re-load by (itemId, owner) — re-verifies ownership at apply time (item.user is the owner).
    const existing = await itemsDAO.findByOwnerAndId(payload.target.itemId, payload.user);
    if (!existing) {
        return { ok: false, status: 404, code: 'item_not_found', message: 'Item not found.' };
    }

    const merged = sanitizeStaleFields({ ...existing, ...submittedPatch, updatedTs: dayjs().toISOString() } as ItemInterface, submittedPatch);

    try {
        // `tokenId` is either a real bearer token id (`api:<id>`) or, for a first-party session
        // caller, `session:<sessionId>` → `api:session:<sessionId>`. Either way the deviceId starts
        // with `api:`, which is the prefix `applyAndPublishOperation` keys on to fan the op out to ALL
        // of the user's devices (including the originator) — required since the client doesn't write
        // IDB optimistically and must receive its own op via pull/SSE.
        await applyAndPublishOperation(
            payload.user,
            { entityType: 'item', opType: 'update', entityId: existing._id as string, snapshot: merged },
            { deviceId: `api:${tokenId}`, strict: true },
        );
        return { ok: true, item: merged };
    } catch (err) {
        if (err instanceof OperationValidationError) {
            return { ok: false, status: 400, code: 'invalid_operation', message: err.message };
        }
        throw err;
    }
}
