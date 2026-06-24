// COPIED from mcp-server/src/tools/reassign.ts — source of truth. Keep in sync (see mcpToolParity.test.ts).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../apiClient.js';
import { defineTool, idSchema, registerOne } from './types.js';

/**
 * Cross-account reassign — move an item or routine from the calling token's user to another
 * user via the two-token consent gesture (caller's `reassign` scope plus the recipient's
 * `reassign.accept` scope).
 *
 * People and workContexts cannot be reassigned. When the moved item/routine carries
 * `peopleIds`/`workContextIds` (or `waitingForPersonId`), the server resolves each ref into the
 * recipient's account: an existing person with the same email or name is reused; otherwise a
 * new mirror record is created under the recipient. The source user keeps an untouched copy of
 * the person/workContext they originally owned.
 *
 * The model never spells out a `toUserId`: the tool calls `GET /v1/me` against the recipient
 * account's token to resolve it server-side. This keeps raw Better Auth UUIDs out of the
 * model's context window — accounts are addressed only by their human-friendly `account`
 * label (matched to the env vars `GTD_API_TOKEN` / `GTD_API_TOKEN_<LABEL>`).
 */

interface MeResponse {
    userId: string;
    label: string;
    email?: string;
}

const reassign = defineTool({
    name: 'gtd_reassign',
    description:
        'Move an item or routine from one account to another. People and workContexts cannot be reassigned; ' +
        'if the moved entity carries peopleIds/workContextIds, the server auto-relinks them into the recipient ' +
        '(reusing an existing person by email/name or creating a mirror record). The MCP attaches both bearers ' +
        'automatically: `fromAccount` signs the call with `reassign`; `toAccount` is sent as the recipient consent ' +
        'token (`X-Reassign-Recipient-Token`) and must hold `reassign.accept`. Account labels are the slugs configured ' +
        'via `GTD_API_TOKEN_<LABEL>` env vars; `default` is reserved for `GTD_API_TOKEN`. Use this for "move this task ' +
        'into my work account" gestures across the same person\'s accounts.',
    inputSchema: {
        entityType: z.enum(['item', 'routine']),
        entityId: idSchema,
        fromAccount: z.string().min(1).default('default').describe('Account label whose token initiates the move. Defaults to "default".'),
        toAccount: z.string().min(1).describe('Account label whose token consents to receive the move. Must differ from fromAccount.'),
        editPatch: z.record(z.string(), z.unknown()).optional().describe('Optional field-level edits applied during the move (item path).'),
        editRoutinePatch: z.record(z.string(), z.unknown()).optional(),
        targetCalendar: z
            .object({
                integrationId: z.string(),
                syncConfigId: z.string(),
            })
            .optional()
            .describe('Required when reassigning a calendar-linked item — the destination GCal connection.'),
    },
    handler: async (args, api) => {
        // Resolve toUserId via /v1/me on the recipient token so the model never sees raw UUIDs.
        const me = await api.request<MeResponse>('GET', '/v1/me', undefined, undefined, { account: args.toAccount });
        const { fromAccount, toAccount, ...body } = args;
        return api.request('POST', '/v1/reassign', { ...body, toUserId: me.userId }, undefined, { account: fromAccount, recipientAccount: toAccount });
    },
});

export function registerReassignTools(server: McpServer, api: ApiClient): void {
    registerOne(server, reassign, api);
}

export const _reassignToolsForTesting = { reassign };
