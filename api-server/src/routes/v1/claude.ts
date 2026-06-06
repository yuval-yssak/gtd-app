import { Hono } from 'hono';
import { authenticateBearer, type BearerVariables } from '../../auth/bearerMiddleware.js';
import { authenticatedRateLimit } from '../../auth/rateLimitMiddleware.js';
import { requireScope } from '../../auth/scopeMiddleware.js';
import itemsDAO from '../../dataAccess/itemsDAO.js';
import { runClarifyLoop } from '../../lib/claude/agentLoop.js';
import { applyItemPatch } from '../../lib/claude/applyProposal.js';
import { hashPayload, signExecuteToken, verifyExecuteToken } from '../../lib/claude/executeToken.js';
import { type ClarifyProposal, PROPOSABLE_ITEM_FIELDS, type ProposableItemField, type ProposedItemPatch } from '../../lib/claude/proposalSchema.js';

/**
 * Lane A — synchronous, single-turn Claude "Clarify with Claude" agent (issue #21).
 *
 * `POST /v1/claude/assist` runs a bounded server-side tool-use loop over the user's GTD data and
 * returns a reviewable proposal (summary + optional item patch + side-effects). `POST
 * /v1/claude/assist/apply` redeems a short-lived signed `executeToken` and performs the approved
 * write through the existing op-log (`applyAndPublishOperation`), so undo / sync / GCal-pushback
 * all work for free.
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

interface ApplyBody {
    executeToken?: unknown;
    /** The (possibly user-edited) item patch to apply. Defaults to the proposed patch the token was minted for. */
    patch?: unknown;
}

/**
 * Mints an `executeToken` for the proposal's item patch (when present) and prepends it as an
 * `itemPatch` side-effect. The token's authorized `fields` are exactly the keys the model proposed,
 * intersected with the proposable allowlist — so a later apply can edit those values but not widen
 * the field set. The model never sees the token; it is minted here, server-side, post-loop.
 */
function withExecuteTokens(proposal: ClarifyProposal, ownerUserId: string, itemId: string): ClarifyProposal {
    if (!proposal.proposedItemPatch || Object.keys(proposal.proposedItemPatch).length === 0) {
        return proposal;
    }
    const fields = Object.keys(proposal.proposedItemPatch).filter((f): f is ProposableItemField => (PROPOSABLE_ITEM_FIELDS as readonly string[]).includes(f));
    const executeToken = signExecuteToken({
        kind: 'itemPatch',
        user: ownerUserId,
        target: { itemId, fields },
        payloadHash: hashPayload(proposal.proposedItemPatch),
    });
    return {
        ...proposal,
        proposedSideEffects: [{ kind: 'itemPatch', preview: proposal.summary, executeToken }, ...proposal.proposedSideEffects],
    };
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
            return c.json(withExecuteTokens(proposal, ownerUserId, item._id as string), 200);
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
    .post('/claude/assist/apply', requireScope('claude.assist'), async (c) => {
        const { userId, tokenId } = c.var.apiAuth;
        const body = (await c.req.json().catch(() => null)) as ApplyBody | null;
        const token = typeof body?.executeToken === 'string' ? body.executeToken : null;
        if (!token) {
            return c.json({ error: 'executeToken is required.', code: 'invalid_request' }, 400);
        }

        const verified = verifyExecuteToken(token);
        if (!verified.ok) {
            const status = verified.code === 'execute_token_expired' ? 410 : 400;
            return c.json({ error: 'The approval is no longer valid; re-run assist.', code: verified.code }, status);
        }

        // Defense in depth: the token's owner must match the authenticated caller. The token already
        // binds the owner, but this rejects a token minted for one account being redeemed by another.
        if (verified.payload.user !== userId) {
            return c.json({ error: 'This approval does not belong to the current account.', code: 'forbidden' }, 403);
        }

        if (verified.payload.kind !== 'itemPatch') {
            return c.json({ error: 'Unsupported approval kind.', code: 'invalid_request' }, 400);
        }

        // The patch is the (possibly edited) values to write. A missing/empty patch is rejected by
        // applyItemPatch (a no-op write is not allowed) rather than silently applied.
        const patch = (body?.patch ?? {}) as ProposedItemPatch;
        const result = await applyItemPatch(verified.payload, patch, tokenId);
        if (!result.ok) {
            return c.json({ error: result.message, code: result.code }, result.status);
        }
        return c.json({ applied: true, item: { id: result.item._id, status: result.item.status, title: result.item.title } }, 200);
    });
