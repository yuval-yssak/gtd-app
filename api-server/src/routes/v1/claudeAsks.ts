import { Hono } from 'hono';
import { z } from 'zod';
import { authenticateBearer, type BearerVariables } from '../../auth/bearerMiddleware.js';
import { authenticatedRateLimit } from '../../auth/rateLimitMiddleware.js';
import { requireScope } from '../../auth/scopeMiddleware.js';
import { type ClaudeAskReport, reportClaudeAskResult } from '../../lib/claudeAsks.js';
import { CLAUDE_ASK_SUMMARY_MAX_CHARS, claudeAskOutcomeSchema } from '../../schemas/operations/claudeAsk.js';

const ClaudeAskReportSchema = z.object({
    summary: z.string().trim().min(1).max(CLAUDE_ASK_SUMMARY_MAX_CHARS),
    outcome: claudeAskOutcomeSchema.default('completed'),
});

/** `{ summary, outcome? }` — outcome defaults to `completed`. */
export function parseClaudeAskReport(raw: unknown): { ok: true; report: ClaudeAskReport } | { ok: false; message: string } {
    const parsed = ClaudeAskReportSchema.safeParse(raw);
    return parsed.success
        ? { ok: true, report: parsed.data }
        : { ok: false, message: `summary must be 1–${CLAUDE_ASK_SUMMARY_MAX_CHARS} characters; outcome "completed" or "needsInput"` };
}

export const v1ClaudeAsksRoutes = new Hono<{ Variables: BearerVariables }>()
    .use('*', authenticateBearer)
    .use('*', authenticatedRateLimit())

    // ── PUT /v1/claude-asks/:id/result — Claude reports what a started session did ──
    // Called by the Claude routine session itself (MCP `done_report_claude_ask`) at the end of a
    // run. Idempotent: a repeated report replaces the previous one.
    .put('/claude-asks/:id/result', requireScope('items.write'), async (c) => {
        const { userId, tokenId } = c.var.apiAuth;
        const parsed = parseClaudeAskReport(await c.req.json().catch(() => null));
        if (!parsed.ok) {
            return c.json({ error: parsed.message, code: 'validation_failed' }, 400);
        }
        const ask = await reportClaudeAskResult(userId, c.req.param('id'), parsed.report, `api:${tokenId}`);
        if (!ask) {
            return c.json({ error: 'claude ask not found', code: 'not_found' }, 404);
        }
        return c.json(ask);
    });
