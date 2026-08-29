// COPIED from mcp-server/src/tools/batch.ts — source of truth. Keep in sync (see mcpToolParity.test.ts).
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
 * The server stamps `snapshot.updatedTs` itself (a caller-echoed value carries no ordering
 * meaning and a stale one would silently lose last-write-wins) and returns the authoritative
 * value in the per-op `results` array, alongside `applyStatus` and a web `url`.
 *
 * Item hard-delete is NOT permitted here — the server rejects {entityType:'item', opType:'delete'}
 * with 400 because a hard delete is unrecoverable. To dispose of an item use `gtd_trash_item`
 * (recoverable soft-delete). `opType:'delete'` remains valid for routine/person/workContext ops.
 */

const batch = defineTool({
    name: 'gtd_batch',
    description:
        'Submit a heterogeneous batch of primitive ops atomically. Each op is {entityType, opType, entityId, snapshot}. ' +
        'snapshot is a full entity object (or null for delete). The server re-stamps snapshot.user AND snapshot.updatedTs ' +
        '(server-assigned on every write — a caller-supplied updatedTs is ignored) before persisting. The response carries ' +
        'per-op results: {entityType, entityId, opType, applyStatus, updatedTs, url}. applyStatus "applied" means the write ' +
        'landed; "skipped_missing" means an update targeted a row that no longer exists (not resurrected); "skipped_stale" ' +
        'means it lost last-write-wins; "skipped_duplicate_key" means it hit a unique index owned by another row. ' +
        'updatedTs is non-null ONLY for an applied non-delete op — never treat the echo of a skipped op as current state. ' +
        'Atomic w.r.t. validation and scope; NOT atomic w.r.t. mid-flight Mongo failures (same caveat as /sync/push). ' +
        'Note: item hard-delete is rejected ({entityType:"item", opType:"delete"} → 400) because it is unrecoverable — ' +
        'use gtd_trash_item to dispose of an item (recoverable soft-delete). opType:"delete" is still valid for ' +
        'routine, person, and workContext entities.',
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
