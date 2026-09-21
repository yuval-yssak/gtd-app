import { type Context, Hono } from 'hono';
import { authenticateBearerOrSessionWith } from '../../auth/assistAuthMiddleware.js';
import type { BearerVariables } from '../../auth/bearerMiddleware.js';
import { authenticatedRateLimit } from '../../auth/rateLimitMiddleware.js';
import { requireScope } from '../../auth/scopeMiddleware.js';
import itemsDAO from '../../dataAccess/itemsDAO.js';
import { chargeBriefGeneration } from '../../lib/brief/briefCap.js';
import { briefErrorToHttp } from '../../lib/brief/briefModel.js';
import { type BriefPlan, executeBriefPlan, type GenerateBriefParams, type GenerateBriefResult, planBriefGeneration } from '../../lib/brief/briefService.js';
import { loadBrief } from '../../lib/itemBriefs.js';
import { presentItem } from './projections/item.js';

/**
 * `POST /v1/items/:id/brief/generate` — on-demand brief generation (docs/plans/item-brief.md § 2.2).
 *
 * Dual auth like `/v1/claude/*`: an external bearer token carrying `items.write`, OR the
 * first-party session cookie (which synthesises `items.write` — the user acting on their own
 * data). Mounted SEPARATELY from `v1Routes` and BEFORE it in `index.ts`, under the credentialed
 * `assistCors()` profile, for the same reason the assist routes are (see routes/v1/index.ts).
 *
 * Two rate limits stack: the token's write bucket (`authenticatedRateLimit`) and the per-USER
 * generation cap (`lib/brief/briefCap.ts`), charged only for a plan that will reach the model.
 */

const SESSION_DEVICE_ID = 'server:brief-ondemand';

type RouteContext = Context<{ Variables: BearerVariables }>;

/** A cookie session has no token to attribute the op to; bearer callers keep the `api:<tokenId>` convention. */
function deviceIdFor(tokenId: string): string {
    return tokenId.startsWith('session:') ? SESSION_DEVICE_ID : `api:${tokenId}`;
}

/** Strict, not coercive: only the boolean `true` forces. */
export function parseForce(body: unknown): boolean {
    return !!body && typeof body === 'object' && 'force' in body && body.force === true;
}

/** The 429 for a model-bound plan over the user's cap, or `null` when the request may proceed. */
function capRejection(c: RouteContext, plan: BriefPlan, userId: string) {
    if (plan.kind !== 'model') {
        return null;
    }
    const retryAfterSec = chargeBriefGeneration(userId);
    if (retryAfterSec === null) {
        return null;
    }
    c.header('Retry-After', String(retryAfterSec));
    return c.json({ error: 'Too many brief generations. Please wait before generating more.', code: 'rate_limited' }, 429);
}

type GenerationAttempt = { ok: true; value: GenerateBriefResult } | { ok: false; error: ReturnType<typeof briefErrorToHttp> };

/** Runs the planned generation and folds a thrown model error into a loggable HTTP error. */
async function runGeneration(plan: BriefPlan, params: GenerateBriefParams): Promise<GenerationAttempt> {
    try {
        return { ok: true, value: await executeBriefPlan(plan, params) };
    } catch (err) {
        const error = briefErrorToHttp(err);
        console.error(`[brief-generate] ${error.logLine}`);
        return { ok: false, error };
    }
}

function errorResponse(c: RouteContext, error: ReturnType<typeof briefErrorToHttp>) {
    if (error.retryAfterSec !== undefined) {
        c.header('Retry-After', String(error.retryAfterSec));
    }
    return c.json({ error: error.message, code: error.code }, error.status);
}

/**
 * Maps the service outcome to the response contract; `item` is re-read so its `brief` reflects
 * the write. A `pinned` outcome can also surface AFTER a model plan (an authored brief landed
 * mid-flight) — the 409 is still right, the model call was simply spent.
 */
async function respond(c: RouteContext, { userId, itemId }: GenerateBriefParams, result: GenerateBriefResult) {
    if (result.outcome === 'not_found') {
        return c.json({ error: 'item not found', code: 'not_found' }, 404);
    }
    // 409, not a silent `skipped`: the caller asked for a brief and is not getting one, and the
    // reason is the item's state rather than a transient failure. Mirrors `brief_pinned` — same
    // status, same shape — and `force` deliberately does NOT override it: a done/trash item is out
    // of scope for generation, not merely protected.
    if (result.outcome === 'not_briefable') {
        return c.json({ error: 'Briefs are only generated for open items — this item is done or trashed.', code: 'brief_not_applicable' }, 409);
    }
    if (result.outcome === 'pinned') {
        return c.json({ error: 'This item has a user- or agent-authored brief. Send { force: true } to replace it.', code: 'brief_pinned' }, 409);
    }
    const item = await itemsDAO.findByOwnerAndId(itemId, userId);
    if (!item) {
        return c.json({ error: 'item not found', code: 'not_found' }, 404);
    }
    return c.json({ outcome: result.outcome, item: presentItem(item, await loadBrief(userId, itemId)), brief: result.brief }, 200);
}

export const v1BriefGenerateRoutes = new Hono<{ Variables: BearerVariables }>()
    .use('/items/:id/brief/generate', authenticateBearerOrSessionWith(['items.write']))
    .use('/items/:id/brief/generate', authenticatedRateLimit())
    .post('/items/:id/brief/generate', requireScope('items.write'), async (c) => {
        const { userId, tokenId } = c.var.apiAuth;
        const force = parseForce(await c.req.json().catch(() => null));
        const params: GenerateBriefParams = { userId, itemId: c.req.param('id'), deviceId: deviceIdFor(tokenId), force };

        const plan = await planBriefGeneration(params);
        const rejected = capRejection(c, plan, userId);
        if (rejected) {
            return rejected;
        }
        const attempt = await runGeneration(plan, params);
        return attempt.ok ? respond(c, params, attempt.value) : errorResponse(c, attempt.error);
    });
