// COPIED from mcp-server/src/tools/claudeAsks.ts — source of truth. Keep in sync (see mcpToolParity.test.ts).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../apiClient.js';
import { accountSchema, CHANGES_IDEMPOTENTLY, defineTool, idSchema, registerOne, requestOptsFromArgs } from './types.js';

/**
 * The report-back leg of the in-app "Ask Claude" feature. Done starts the user's Claude routine
 * (a Claude Code cloud routine — not a Done routine) with a request that names an ask id; the
 * session calls this tool when it finishes so the item's Ask Claude history shows what happened.
 */
const reportClaudeAsk = defineTool({
    name: 'done_report_claude_ask',
    title: 'Report Claude ask result',
    safety: CHANGES_IDEMPOTENTLY,
    description:
        'Call this ONLY when a request from the Done app ("Ask Claude") gave you an `askId` and told you to report back. ' +
        "Writes a one-line summary of what you did onto that ask, shown in the item's Ask Claude history in Done. " +
        'Use outcome "needsInput" when you stopped because the user must decide or answer something, and say what you ' +
        'need in the summary; otherwise "completed" (the default). Reporting again replaces the earlier report. ' +
        'Returns the updated ask.',
    inputSchema: {
        askId: idSchema,
        summary: z.string().min(1).max(280).describe('One line (≤ 280 chars): what you did, or what you need from the user.'),
        outcome: z.enum(['completed', 'needsInput']).optional().describe('Defaults to "completed".'),
        account: accountSchema,
    },
    handler: async (args, api) =>
        api.request(
            'PUT',
            `/v1/claude-asks/${encodeURIComponent(args.askId)}/result`,
            { summary: args.summary, ...(args.outcome === undefined ? {} : { outcome: args.outcome }) },
            undefined,
            requestOptsFromArgs({ account: args.account }),
        ),
});

export function registerClaudeAskTools(server: McpServer, api: ApiClient): void {
    registerOne(server, reportClaudeAsk, api);
}

// Re-exported for tests.
export const _claudeAskToolsForTesting = { reportClaudeAsk };
