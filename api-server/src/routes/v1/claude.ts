import { Hono } from 'hono';
import { authenticateBearer, type BearerVariables } from '../../auth/bearerMiddleware.js';
import { authenticatedRateLimit } from '../../auth/rateLimitMiddleware.js';
import { requireScope } from '../../auth/scopeMiddleware.js';
import itemsDAO from '../../dataAccess/itemsDAO.js';
import { runClarifyLoop } from '../../lib/claude/agentLoop.js';

/**
 * Lane A — synchronous, single-turn Claude "Clarify with Claude" agent (issue #21).
 *
 * `POST /v1/claude/assist` runs a bounded server-side tool-use loop over the user's GTD data and
 * returns a reviewable proposal (summary + optional item patch + side-effects). `POST
 * /v1/claude/assist/apply` redeems a short-lived signed `executeToken` and performs the approved
 * write through the existing op-log (`applyAndPublishOperation`), so undo / sync / GCal-pushback
 * all work for free. (apply + executeToken land in step (c).)
 *
 * Both endpoints are gated on the dedicated `claude.assist` scope. The agent always acts as the
 * account that OWNS the target item (`item.user`), never the caller's session — the handler loads
 * the item, verifies ownership, and scopes every downstream read to `item.user`.
 */

// Wall-clock ceiling for the whole loop. A stuck call fails fast rather than holding the request.
const ASSIST_TIMEOUT_MS = 25_000;

interface AssistBody {
    itemId?: unknown;
    instruction?: unknown;
}

export const v1ClaudeRoutes = new Hono<{ Variables: BearerVariables }>()
    .use('*', authenticateBearer)
    .use('*', authenticatedRateLimit())
    .post('/claude/assist', requireScope('claude.assist'), async (c) => {
        const { userId } = c.var.apiAuth;
        const body = (await c.req.json().catch(() => null)) as AssistBody | null;
        const itemId = typeof body?.itemId === 'string' ? body.itemId : null;
        const instruction = typeof body?.instruction === 'string' ? body.instruction : undefined;
        if (!itemId) {
            return c.json({ error: 'itemId is required.', code: 'invalid_request' }, 400);
        }

        // Load the item and resolve the OWNER. Multi-account correctness: the agent acts as the
        // item's owner, never the active session. For the bearer path the caller must own the item;
        // a mismatch returns 404 (don't leak whether the id exists for another user).
        const item = await itemsDAO.findByOwnerAndId(itemId, userId);
        if (!item) {
            return c.json({ error: 'Item not found.', code: 'not_found' }, 404);
        }
        const ownerUserId = item.user;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), ASSIST_TIMEOUT_MS);
        try {
            const { proposal } = await runClarifyLoop(item, ownerUserId, instruction, controller.signal);
            return c.json(proposal, 200);
        } catch (err) {
            if (controller.signal.aborted) {
                return c.json({ error: 'The assistant took too long to respond.', code: 'agent_timeout' }, 504);
            }
            const message = err instanceof Error ? err.message : 'The assistant could not complete the request.';
            return c.json({ error: message, code: 'agent_error' }, 502);
        } finally {
            clearTimeout(timeout);
        }
    })
    .post('/claude/assist/apply', requireScope('claude.assist'), (c) => c.json({ error: 'Not implemented yet.', code: 'not_implemented' }, 501));
