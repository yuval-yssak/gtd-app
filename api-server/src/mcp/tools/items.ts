// COPIED from mcp-server/src/tools/items.ts — source of truth. Keep in sync (see mcpToolParity.test.ts).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../apiClient.js';
import { accountSchema, defineTool, idSchema, registerOne, requestOptsFromArgs } from './types.js';

/**
 * Tool definitions for the item surface of the GTD /v1 API. Field shapes mirror what the API
 * accepts; the model gets the matrix described in tool descriptions so it can compose
 * status-transition gestures correctly. Validation is enforced server-side either way.
 *
 * Note on deletion: to dispose of an item, use `gtd_trash_item` (soft-delete → status:'trash',
 * recoverable from the in-app Trash view). There is no item hard-delete on the public API:
 * `gtd_batch` rejects {entityType:'item', opType:'delete'}, and PATCH rejects {status:'trash'}
 * with 409. Trashing is the single, recoverable disposal path for an LLM-driven surface.
 *
 * Multi-account: every tool accepts an optional `account` field — see the README's
 * "Multi-account setup" section. Omitting it uses the `'default'` account.
 */

// PATCH does NOT accept 'trash' — the route rejects it with 409. Omit it from the enum so the
// model never proposes a transition the API will refuse.
const itemStatusSchema = z.enum(['inbox', 'nextAction', 'calendar', 'waitingFor', 'somedayMaybe', 'done']);

const capture = defineTool({
    name: 'gtd_capture',
    description:
        'Capture a new inbox item in GTD. Always lands in `inbox` regardless of any status sent. ' +
        'Optional `externalId` provides strict idempotency (caller-supplied dedupe key, e.g. an email Message-Id). ' +
        'Without externalId, identical (title, notes) within 24h are best-effort de-duped.',
    inputSchema: {
        title: z.string().min(1).describe('Required. Non-empty after trim.'),
        notes: z.string().optional().describe('Optional markdown body.'),
        externalId: z.string().min(1).optional().describe('Caller-supplied dedupe key for strict idempotency.'),
        account: accountSchema,
    },
    handler: async ({ account, ...body }, api) => api.request('POST', '/v1/items', body, undefined, requestOptsFromArgs({ account })),
});

const listItems = defineTool({
    name: 'gtd_list_items',
    description:
        "List or search the user's items. Sorted by updatedTs DESC. Defaults to all statuses except `trash`. " +
        'Use `cursor` from a previous response to paginate.',
    inputSchema: {
        q: z.string().optional().describe('Case-insensitive literal substring match against title and notes.'),
        status: z
            .string()
            .optional()
            .describe('Comma-separated list of ItemStatus values, e.g. "inbox" or "nextAction,calendar". Defaults to all except trash.'),
        since: z.string().optional().describe('ISO datetime. Only items with updatedTs > since.'),
        limit: z.number().int().positive().max(200).optional().describe('Defaults to 50. Max 200.'),
        cursor: z.string().optional().describe('Opaque cursor from a previous response.'),
        account: accountSchema,
    },
    handler: async (args, api) =>
        api.request(
            'GET',
            '/v1/items',
            undefined,
            { q: args.q, status: args.status, since: args.since, limit: args.limit, cursor: args.cursor },
            requestOptsFromArgs({ account: args.account }),
        ),
});

const getItem = defineTool({
    name: 'gtd_get_item',
    description: 'Fetch a single item by id. 404 if missing or owned by another user.',
    inputSchema: {
        id: idSchema,
        account: accountSchema,
    },
    handler: async (args, api) =>
        api.request('GET', `/v1/items/${encodeURIComponent(args.id)}`, undefined, undefined, requestOptsFromArgs({ account: args.account })),
});

const updateItem = defineTool({
    name: 'gtd_update_item',
    description:
        'Update any user-settable field on an existing item. Supports status transitions ' +
        '(except → trash, which is rejected). Field combinations must satisfy the status×field matrix:\n' +
        '- inbox: title/notes only\n' +
        '- nextAction: workContextIds, peopleIds, energy, time, focus, urgent, expectedBy, ignoreBefore\n' +
        '- calendar: timeStart, timeEnd, calendarEventId, calendarIntegrationId, workContextIds, peopleIds\n' +
        '- waitingFor: waitingForPersonId (optional — a waitingFor item need not name a person), peopleIds, expectedBy, ignoreBefore\n' +
        '- somedayMaybe: expectedBy, ignoreBefore\n' +
        'Caller-supplied fields incompatible with the target status return 400 status_field_violation with extra:{status,field}.',
    inputSchema: {
        id: idSchema,
        title: z.string().min(1).optional(),
        notes: z.string().optional(),
        status: itemStatusSchema.optional(),
        workContextIds: z.array(z.string()).optional(),
        peopleIds: z.array(z.string()).optional(),
        waitingForPersonId: z.string().optional(),
        energy: z.enum(['low', 'medium', 'high']).optional(),
        time: z.number().nonnegative().optional(),
        focus: z.boolean().optional(),
        urgent: z.boolean().optional(),
        expectedBy: z.string().optional().describe('YYYY-MM-DD or ISO datetime. Allowed on nextAction / waitingFor / somedayMaybe.'),
        ignoreBefore: z.string().optional().describe('YYYY-MM-DD. Tickler — hides item until this date. Allowed on nextAction / waitingFor / somedayMaybe.'),
        timeStart: z.string().optional().describe('Floating ISO datetime. Allowed only on calendar items.'),
        timeEnd: z.string().optional().describe('Floating ISO datetime. Allowed only on calendar items.'),
        calendarEventId: z.string().optional(),
        calendarIntegrationId: z.string().optional(),
        calendarSyncConfigId: z.string().optional(),
        account: accountSchema,
    },
    handler: async ({ id, account, ...patch }, api) =>
        api.request('PATCH', `/v1/items/${encodeURIComponent(id)}`, patch, undefined, requestOptsFromArgs({ account })),
});

const completeItem = defineTool({
    name: 'gtd_complete_item',
    description: 'Mark an item as done. Idempotent — completing a done item returns the unchanged item.',
    inputSchema: {
        id: idSchema,
        account: accountSchema,
    },
    handler: async (args, api) =>
        api.request('POST', `/v1/items/${encodeURIComponent(args.id)}/complete`, {}, undefined, requestOptsFromArgs({ account: args.account })),
});

const trashItem = defineTool({
    name: 'gtd_trash_item',
    description:
        'Trash (soft-delete) a single item — moves it to `status: "trash"`. This is the correct way to dispose of an item: ' +
        "it is RECOVERABLE (the item stays in the user's in-app Trash view and can be restored), unlike a hard delete which is " +
        'permanent. Idempotent — trashing an already-trashed item returns it unchanged. If the item belongs to an active ' +
        'nextAction routine, the next occurrence is generated automatically.',
    inputSchema: {
        id: idSchema,
        account: accountSchema,
    },
    handler: async (args, api) =>
        api.request('POST', `/v1/items/${encodeURIComponent(args.id)}/trash`, {}, undefined, requestOptsFromArgs({ account: args.account })),
});

export function registerItemTools(server: McpServer, api: ApiClient): void {
    registerOne(server, capture, api);
    registerOne(server, listItems, api);
    registerOne(server, getItem, api);
    registerOne(server, updateItem, api);
    registerOne(server, completeItem, api);
    registerOne(server, trashItem, api);
}

// Re-exported for tests.
export const _itemToolsForTesting = { capture, listItems, getItem, updateItem, completeItem, trashItem };
