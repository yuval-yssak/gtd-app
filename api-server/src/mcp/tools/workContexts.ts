// COPIED from mcp-server/src/tools/workContexts.ts — source of truth. Keep in sync (see mcpToolParity.test.ts).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../apiClient.js';
import { ADDS, accountSchema, CHANGES_IDEMPOTENTLY, defineTool, idSchema, READS, registerOne, requestOptsFromArgs } from './types.js';

/**
 * Work-context CRUD. Work contexts are condition tags (e.g. "near a phone", "at computer")
 * referenced from items via `workContextIds`. Deletion does NOT cascade. Multi-account: every
 * tool accepts an optional `account`.
 */

const listWorkContexts = defineTool({
    name: 'done_list_work_contexts',
    title: 'List work contexts',
    safety: READS,
    description:
        "List the user's work contexts — the named conditions a task needs (a place, a tool, a situation). " +
        'Use it to find the id an item or routine template takes in `workContextIds`. Sorted by updatedTs DESC.',
    inputSchema: {
        limit: z.number().int().positive().max(500).optional(),
        cursor: z.string().optional(),
        since: z.string().optional().describe('ISO datetime; only contexts with updatedTs > since.'),
        account: accountSchema,
    },
    handler: async (args, api) =>
        api.request(
            'GET',
            '/v1/work-contexts',
            undefined,
            { limit: args.limit, cursor: args.cursor, since: args.since },
            requestOptsFromArgs({ account: args.account }),
        ),
});

const getWorkContext = defineTool({
    name: 'done_get_work_context',
    title: 'Get work context',
    safety: READS,
    description: 'Fetch a single work context by id.',
    inputSchema: { id: idSchema, account: accountSchema },
    handler: async (args, api) =>
        api.request('GET', `/v1/work-contexts/${encodeURIComponent(args.id)}`, undefined, undefined, requestOptsFromArgs({ account: args.account })),
});

const createWorkContext = defineTool({
    name: 'done_create_work_context',
    title: 'Create work context',
    safety: ADDS,
    description:
        'Create a work context: a named condition under which tasks can be done (a place, a tool, a situation). ' +
        'Check done_list_work_contexts first so an existing one is reused instead of duplicated.',
    inputSchema: { name: z.string().min(1), account: accountSchema },
    handler: async ({ account, ...body }, api) => api.request('POST', '/v1/work-contexts', body, undefined, requestOptsFromArgs({ account })),
});

const updateWorkContext = defineTool({
    name: 'done_update_work_context',
    title: 'Rename work context',
    safety: CHANGES_IDEMPOTENTLY,
    description: 'Rename a work context. Items and routines that reference it keep the reference.',
    inputSchema: {
        id: idSchema,
        name: z.string().min(1),
        account: accountSchema,
    },
    handler: async ({ id, account, ...patch }, api) =>
        api.request('PATCH', `/v1/work-contexts/${encodeURIComponent(id)}`, patch, undefined, requestOptsFromArgs({ account })),
});

const deleteWorkContext = defineTool({
    name: 'done_delete_work_context',
    title: 'Delete work context',
    safety: CHANGES_IDEMPOTENTLY,
    description: 'Delete a work context. Idempotent. Does NOT cascade.',
    inputSchema: { id: idSchema, account: accountSchema },
    handler: async (args, api) =>
        api.request('DELETE', `/v1/work-contexts/${encodeURIComponent(args.id)}`, undefined, undefined, requestOptsFromArgs({ account: args.account })),
});

export function registerWorkContextTools(server: McpServer, api: ApiClient): void {
    registerOne(server, listWorkContexts, api);
    registerOne(server, getWorkContext, api);
    registerOne(server, createWorkContext, api);
    registerOne(server, updateWorkContext, api);
    registerOne(server, deleteWorkContext, api);
}

export const _workContextToolsForTesting = { listWorkContexts, getWorkContext, createWorkContext, updateWorkContext, deleteWorkContext };
