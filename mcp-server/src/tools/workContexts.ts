import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../apiClient.js';
import { accountSchema, defineTool, idSchema, registerOne, requestOptsFromArgs } from './types.js';

/**
 * Work-context CRUD. Work contexts are condition tags (e.g. "near a phone", "at computer")
 * referenced from items via `workContextIds`. Deletion does NOT cascade. Multi-account: every
 * tool accepts an optional `account`.
 */

const listWorkContexts = defineTool({
    name: 'gtd_list_work_contexts',
    description: "List the user's work contexts. Sorted by updatedTs DESC.",
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
    name: 'gtd_get_work_context',
    description: 'Fetch a single work context by id.',
    inputSchema: { id: idSchema, account: accountSchema },
    handler: async (args, api) =>
        api.request('GET', `/v1/work-contexts/${encodeURIComponent(args.id)}`, undefined, undefined, requestOptsFromArgs({ account: args.account })),
});

const createWorkContext = defineTool({
    name: 'gtd_create_work_context',
    description: 'Create a new work context tag.',
    inputSchema: { name: z.string().min(1), account: accountSchema },
    handler: async ({ account, ...body }, api) => api.request('POST', '/v1/work-contexts', body, undefined, requestOptsFromArgs({ account })),
});

const updateWorkContext = defineTool({
    name: 'gtd_update_work_context',
    description: 'Update an existing work context.',
    inputSchema: {
        id: idSchema,
        name: z.string().min(1),
        account: accountSchema,
    },
    handler: async ({ id, account, ...patch }, api) =>
        api.request('PATCH', `/v1/work-contexts/${encodeURIComponent(id)}`, patch, undefined, requestOptsFromArgs({ account })),
});

const deleteWorkContext = defineTool({
    name: 'gtd_delete_work_context',
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
