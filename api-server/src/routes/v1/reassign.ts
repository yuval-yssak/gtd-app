import { Hono } from 'hono';
import { resolveBearerToken } from '../../auth/apiTokens.js';
import { authenticateBearer, type BearerVariables } from '../../auth/bearerMiddleware.js';
import { authenticatedRateLimit } from '../../auth/rateLimitMiddleware.js';
import { requireScope } from '../../auth/scopeMiddleware.js';
import { type ReassignParams, reassignEntity } from '../../lib/reassignEntity.js';
import type { ApiTokenInterface, EntityType } from '../../types/entities.js';

/**
 * Public-API wrapper around `lib/reassignEntity.ts` (the same orchestrator that backs the in-app
 * `/sync/reassign` gesture). The bearer token's userId becomes `fromUserId`; the caller supplies
 * `toUserId` directly.
 *
 * **Two-token consent.** The bearer-token analog of the in-app device-multi-session check:
 *   - `Authorization: Bearer <A-token>` — caller, must carry the `reassign` scope.
 *   - `X-Reassign-Recipient-Token: <B-token>` — recipient proof, must carry the `reassign.accept`
 *     scope and belong to `toUserId`.
 * Both must be live (not revoked). Without the recipient header, the route rejects with 400
 * `recipient_consent_required`. This means a stolen `reassign` token cannot dump items into an
 * arbitrary user — the attacker would also need a live `reassign.accept` token from that user.
 */

// Only items and routines can be reassigned via the public API. People and workContexts are
// intentionally NOT reassignable — when an item/routine carrying refs to them is moved, the
// orchestrator auto-relinks each ref into the target user's account (find-or-create by
// email/name). Rejecting at the body-parse layer keeps the error close to the caller; the
// orchestrator also rejects defensively to cover the in-app /sync/reassign path.
const VALID_ENTITY_TYPES = new Set<EntityType>(['item', 'routine']);

interface ReassignBody {
    entityType?: unknown;
    entityId?: unknown;
    toUserId?: unknown;
    editPatch?: unknown;
    editRoutinePatch?: unknown;
    targetCalendar?: unknown;
}

type ParseError = { code: 'invalid_body' | 'invalid_entityType' | 'invalid_entityId' | 'invalid_toUserId'; message: string };

function parseReassignBody(raw: ReassignBody | null, fromUserId: string): { ok: true; value: ReassignParams } | { ok: false; error: ParseError } {
    if (!raw || typeof raw !== 'object') {
        return { ok: false, error: { code: 'invalid_body', message: 'request body must be a JSON object' } };
    }
    if (typeof raw.entityType !== 'string' || !VALID_ENTITY_TYPES.has(raw.entityType as EntityType)) {
        return { ok: false, error: { code: 'invalid_entityType', message: `entityType must be one of: ${[...VALID_ENTITY_TYPES].join(', ')}` } };
    }
    if (typeof raw.entityId !== 'string' || raw.entityId.trim() === '') {
        return { ok: false, error: { code: 'invalid_entityId', message: 'entityId must be a non-empty string' } };
    }
    if (typeof raw.toUserId !== 'string' || raw.toUserId.trim() === '') {
        return { ok: false, error: { code: 'invalid_toUserId', message: 'toUserId must be a non-empty string' } };
    }
    const params: ReassignParams = {
        entityType: raw.entityType as EntityType,
        entityId: raw.entityId.trim(),
        fromUserId,
        toUserId: raw.toUserId.trim(),
        // editPatch / editRoutinePatch / targetCalendar pass through opaquely; reassignEntity's
        // own whitelist (`applyItemEditPatch`, etc.) drops anything outside the per-entity allowlist.
        // NonNullable strips `| undefined` from the optional types so spread satisfies
        // exactOptionalPropertyTypes — the precondition guards already narrowed each value.
        ...(raw.editPatch !== undefined ? { editPatch: raw.editPatch as NonNullable<ReassignParams['editPatch']> } : {}),
        ...(raw.editRoutinePatch !== undefined ? { editRoutinePatch: raw.editRoutinePatch as NonNullable<ReassignParams['editRoutinePatch']> } : {}),
        ...(raw.targetCalendar !== undefined ? { targetCalendar: raw.targetCalendar as NonNullable<ReassignParams['targetCalendar']> } : {}),
    };
    return { ok: true, value: params };
}

type ConsentFailure =
    | { code: 'recipient_consent_required'; status: 400; message: string }
    | { code: 'invalid_recipient_token'; status: 401; message: string }
    | { code: 'recipient_token_mismatch'; status: 403; message: string }
    | { code: 'recipient_scope_missing'; status: 403; message: string }
    | { code: 'same_token'; status: 400; message: string };

/**
 * Validates the recipient-consent token attached as `X-Reassign-Recipient-Token`. Returns the
 * resolved row on success, or a structured failure shape that the route turns into a JSON error.
 * The recipient token must belong to `toUserId`, carry `reassign.accept`, and differ from the
 * caller's token. We do not distinguish "unknown" from "revoked" here — both surface as 401 to
 * mirror what `authenticateBearer` does for the primary token.
 */
async function validateRecipientConsent(
    headerValue: string | undefined,
    callerTokenId: string,
    toUserId: string,
): Promise<{ ok: true; token: ApiTokenInterface } | { ok: false; failure: ConsentFailure }> {
    if (!headerValue || headerValue.trim() === '') {
        return {
            ok: false,
            failure: {
                code: 'recipient_consent_required',
                status: 400,
                message: 'X-Reassign-Recipient-Token header is required: send a recipient token carrying the reassign.accept scope',
            },
        };
    }
    // Defensive: callers copy-pasting from `Authorization` examples sometimes prefix the recipient
    // header with "Bearer ", which then gets double-prefixed below and turns a valid token into a
    // 401 invalid_recipient_token with no hint of the cause. Strip it case-insensitively before
    // re-prefixing for `resolveBearerToken`.
    const trimmed = headerValue.trim();
    const bare = trimmed.toLowerCase().startsWith('bearer ') ? trimmed.slice(7).trim() : trimmed;
    const recipient = await resolveBearerToken(`Bearer ${bare}`);
    if (!recipient) {
        return { ok: false, failure: { code: 'invalid_recipient_token', status: 401, message: 'X-Reassign-Recipient-Token did not resolve to a live token' } };
    }
    if (recipient._id === callerTokenId) {
        return { ok: false, failure: { code: 'same_token', status: 400, message: 'recipient token must differ from the calling token' } };
    }
    if (recipient.user !== toUserId) {
        return { ok: false, failure: { code: 'recipient_token_mismatch', status: 403, message: 'recipient token does not belong to toUserId' } };
    }
    if (!recipient.scopes?.includes('reassign.accept')) {
        return { ok: false, failure: { code: 'recipient_scope_missing', status: 403, message: 'recipient token must carry the reassign.accept scope' } };
    }
    return { ok: true, token: recipient };
}

export const v1ReassignRoutes = new Hono<{ Variables: BearerVariables }>()
    .use('*', authenticateBearer)
    .use('*', authenticatedRateLimit())

    // ── POST /v1/reassign ───────────────────────────────────────────────────
    .post('/reassign', requireScope('reassign'), async (c) => {
        const { userId, tokenId } = c.var.apiAuth;
        const raw = (await c.req.json().catch(() => null)) as ReassignBody | null;
        const parsed = parseReassignBody(raw, userId);
        if (!parsed.ok) {
            return c.json({ error: parsed.error.message, code: parsed.error.code }, 400);
        }
        if (parsed.value.fromUserId === parsed.value.toUserId) {
            return c.json({ error: "toUserId must differ from the calling token's user", code: 'same_user' }, 400);
        }
        const consent = await validateRecipientConsent(c.req.header('X-Reassign-Recipient-Token'), tokenId, parsed.value.toUserId);
        if (!consent.ok) {
            return c.json({ error: consent.failure.message, code: consent.failure.code }, consent.failure.status);
        }
        // Stamp `api:<tokenId>` on the recorded ops so audits can attribute the move to this
        // token (vs. the in-app gesture which records `deviceId='server'`).
        const result = await reassignEntity({ ...parsed.value, deviceId: `api:${tokenId}` });
        if (!result.ok) {
            // `code` is set by the orchestrator only for validation_failed today — fall back to
            // the generic reassign_failed shape for the 400/404 cases so the contract pinned in
            // tests stays stable.
            return c.json({ error: result.error, code: result.code ?? 'reassign_failed' }, result.status);
        }
        return c.json({ ok: true, ...(result.alreadyMoved ? { alreadyMoved: true } : {}) });
    });
