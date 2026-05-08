import { Hono } from 'hono';
import { authenticateBearer, type BearerVariables } from '../../auth/bearerMiddleware.js';
import { authenticatedRateLimit } from '../../auth/rateLimitMiddleware.js';
import { requireScope } from '../../auth/scopeMiddleware.js';
import { buildCalendarProvider } from '../../lib/buildCalendarProvider.js';
import { type ReassignParams, reassignEntity } from '../../lib/reassignEntity.js';
import type { EntityType } from '../../types/entities.js';

/**
 * Public-API wrapper around `lib/reassignEntity.ts` (the same orchestrator that backs the in-app
 * `/sync/reassign` gesture). The bearer token's userId becomes `fromUserId`; the caller supplies
 * `toUserId` directly.
 *
 * **Security note:** unlike `/sync/reassign` (which requires both userIds to have an active
 * Better Auth session on the calling device), the public-API `/v1/reassign` cannot validate that
 * `toUserId` consents to receive the entity. The `reassign` scope is the only gate, and tokens
 * carrying it should be minted with care. Documented in `PUBLIC_API.md` once Phase 4 lands.
 *
 * **Pipeline gap (carry-over from /sync/reassign):** `reassignEntity` writes via `recordOperation`
 * directly rather than `applyAndPublishOperation`. This means a /v1/reassign call:
 *   - skips Zod re-validation of the moved snapshot (safe — the source row was already valid),
 *   - does NOT fire SSE / web push / webhook fan-out for the delete + create pair (other devices
 *     learn about the move on their next pull cycle, and external webhook subscribers do not see
 *     a reassign at all).
 *
 * This is the same gap that has always existed for `/sync/reassign`. Closing it requires
 * refactoring `reassignEntity` to flow through `applyAndPublishOperation`, which is large enough
 * to warrant its own change — tracked for Phase 3. The `deviceId` we pass through (`api:<tokenId>`)
 * is at least visible in audits even without the fan-out.
 */

const VALID_ENTITY_TYPES = new Set<EntityType>(['item', 'routine', 'person', 'workContext']);

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
        // Stamp `api:<tokenId>` on the recorded ops so audits can attribute the move to this
        // token (vs. the in-app gesture which records `deviceId='server'`).
        const result = await reassignEntity({ ...parsed.value, deviceId: `api:${tokenId}` }, buildCalendarProvider);
        if (!result.ok) {
            return c.json({ error: result.error, code: 'reassign_failed' }, result.status);
        }
        return c.json({ ok: true, ...(result.crossUserReferences ? { crossUserReferences: result.crossUserReferences } : {}) });
    });
