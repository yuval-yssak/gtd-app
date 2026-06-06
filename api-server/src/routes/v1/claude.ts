import { Hono } from 'hono';
import { authenticateBearer, type BearerVariables } from '../../auth/bearerMiddleware.js';
import { authenticatedRateLimit } from '../../auth/rateLimitMiddleware.js';
import { requireScope } from '../../auth/scopeMiddleware.js';

/**
 * Lane A — synchronous, single-turn Claude "Clarify with Claude" agent (issue #21).
 *
 * `POST /v1/claude/assist` runs a bounded server-side tool-use loop over the user's GTD data and
 * returns a reviewable proposal (summary + optional item patch + side-effects, each carrying a
 * short-lived signed `executeToken`). `POST /v1/claude/assist/apply` redeems a token and performs
 * the approved write through the existing op-log (`applyAndPublishOperation`), so undo / sync /
 * GCal-pushback all work for free.
 *
 * Both endpoints are gated on the dedicated `claude.assist` scope. The agent always acts as the
 * account that OWNS the target item (`item.user`), never the caller's session — see the handlers.
 *
 * Handlers land in step (b)/(c); this scaffolds the router + middleware so the surface exists and
 * the scope is enforced from the first commit.
 */
export const v1ClaudeRoutes = new Hono<{ Variables: BearerVariables }>()
    .use('*', authenticateBearer)
    .use('*', authenticatedRateLimit())
    .post('/claude/assist', requireScope('claude.assist'), (c) => c.json({ error: 'Not implemented yet.', code: 'not_implemented' }, 501))
    .post('/claude/assist/apply', requireScope('claude.assist'), (c) => c.json({ error: 'Not implemented yet.', code: 'not_implemented' }, 501));
