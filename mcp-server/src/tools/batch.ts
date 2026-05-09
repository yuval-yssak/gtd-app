import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../apiClient.js';
import { accountSchema, defineTool, idSchema, registerOne, requestOptsFromArgs } from './types.js';

/**
 * Heterogeneous batch — submit multiple primitive ops in one request. Use when an integration
 * needs to land related changes atomically (e.g. create a workContext and several items
 * referencing it). The pre-flight checks scope union and rejects 403 with no partial writes;
 * Zod validation also runs up-front so structural errors fail the whole batch.
 *
 * This is also the only public way to opType:'delete' an item — there is no DELETE /v1/items/:id.
 */

const batch = defineTool({
    name: 'gtd_batch',
    description:
        'Submit a heterogeneous batch of primitive ops atomically. Each op is {entityType, opType, entityId, snapshot}. ' +
        'snapshot is a full entity object (or null for delete). The server re-stamps snapshot.user before persisting. ' +
        'Atomic w.r.t. validation and scope; NOT atomic w.r.t. mid-flight Mongo failures (same caveat as /sync/push). ' +
        'Note: this is currently the only public way to delete an item — use {entityType:"item", opType:"delete", entityId, snapshot:null}.',
    inputSchema: {
        ops: z
            .array(
                z
                    .object({
                        entityType: z.enum(['item', 'routine', 'person', 'workContext']),
                        opType: z.enum(['create', 'update', 'delete']),
                        entityId: idSchema,
                        snapshot: z.union([z.record(z.string(), z.unknown()), z.null()]),
                    })
                    .strict(),
            )
            .min(1)
            .max(500)
            .describe('Up to 500 ops. The server returns 400 too_many_ops above that.'),
        account: accountSchema,
    },
    handler: async (args, api) => api.request('POST', '/v1/operations/batch', { ops: args.ops }, undefined, requestOptsFromArgs({ account: args.account })),
});

export function registerBatchTools(server: McpServer, api: ApiClient): void {
    registerOne(server, batch, api);
}

export const _batchToolsForTesting = { batch };
