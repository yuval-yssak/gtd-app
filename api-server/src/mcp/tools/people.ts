// COPIED from mcp-server/src/tools/people.ts — source of truth. Keep in sync (see mcpToolParity.test.ts).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../apiClient.js';
import { accountSchema, defineTool, idSchema, notesSchema, registerOne, requestOptsFromArgs } from './types.js';

/**
 * People CRUD. People are named contacts referenced from items via `peopleIds` and
 * `waitingForPersonId`. Deletion does NOT cascade — references on items are left dangling
 * (the client renders them as "unknown person"). Multi-account: every tool accepts an optional
 * `account` (see types.ts:accountSchema).
 */

const listPeople = defineTool({
    name: 'gtd_list_people',
    description: "List the user's people. Sorted by updatedTs DESC.",
    inputSchema: {
        limit: z.number().int().positive().max(500).optional(),
        cursor: z.string().optional(),
        since: z.string().optional().describe('ISO datetime; only people with updatedTs > since.'),
        account: accountSchema,
    },
    handler: async (args, api) =>
        api.request(
            'GET',
            '/v1/people',
            undefined,
            { limit: args.limit, cursor: args.cursor, since: args.since },
            requestOptsFromArgs({ account: args.account }),
        ),
});

const getPerson = defineTool({
    name: 'gtd_get_person',
    description: 'Fetch a single person by id.',
    inputSchema: { id: idSchema, account: accountSchema },
    handler: async (args, api) =>
        api.request('GET', `/v1/people/${encodeURIComponent(args.id)}`, undefined, undefined, requestOptsFromArgs({ account: args.account })),
});

const createPerson = defineTool({
    name: 'gtd_create_person',
    description:
        'Create a new person. Put contact details in the dedicated `email` and `phone` fields — never bury them in `notes`. Use `notes` for freeform context only (role, Slack handle, timezone, links).',
    inputSchema: {
        name: z.string().min(1),
        email: z.string().optional(),
        phone: z.string().optional(),
        externalCalendarId: z.string().optional(),
        notes: notesSchema,
        account: accountSchema,
    },
    handler: async ({ account, ...body }, api) => api.request('POST', '/v1/people', body, undefined, requestOptsFromArgs({ account })),
});

const updatePerson = defineTool({
    name: 'gtd_update_person',
    description:
        'Update fields on an existing person. At least one field must be present. Contact details belong in the dedicated `email` and `phone` fields, not in `notes`.',
    inputSchema: {
        id: idSchema,
        name: z.string().min(1).optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        externalCalendarId: z.string().optional(),
        notes: notesSchema,
        account: accountSchema,
    },
    handler: async ({ id, account, ...patch }, api) =>
        api.request('PATCH', `/v1/people/${encodeURIComponent(id)}`, patch, undefined, requestOptsFromArgs({ account })),
});

const deletePerson = defineTool({
    name: 'gtd_delete_person',
    description: 'Delete a person. Idempotent. Does NOT cascade — items referencing this person are left dangling.',
    inputSchema: { id: idSchema, account: accountSchema },
    handler: async (args, api) =>
        api.request('DELETE', `/v1/people/${encodeURIComponent(args.id)}`, undefined, undefined, requestOptsFromArgs({ account: args.account })),
});

export function registerPeopleTools(server: McpServer, api: ApiClient): void {
    registerOne(server, listPeople, api);
    registerOne(server, getPerson, api);
    registerOne(server, createPerson, api);
    registerOne(server, updatePerson, api);
    registerOne(server, deletePerson, api);
}

export const _peopleToolsForTesting = { listPeople, getPerson, createPerson, updatePerson, deletePerson };
