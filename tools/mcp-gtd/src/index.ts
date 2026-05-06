#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { GtdApiError, GtdClient } from './gtdClient.js';

function readConfig(): { baseUrl: string; token: string } {
    const baseUrl = process.env.GTD_API_BASE_URL;
    const token = process.env.GTD_API_TOKEN;
    if (!baseUrl) {
        throw new Error('GTD_API_BASE_URL env var is required (e.g. http://localhost:4000/v1)');
    }
    if (!token) {
        throw new Error('GTD_API_TOKEN env var is required (mint one in the app under Settings → Personal API tokens, or in local dev via POST /dev/api-tokens)');
    }
    return { baseUrl, token };
}

/** Wraps a client call so MCP returns a structured error rather than crashing the process. */
async function callClient<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    try {
        return { ok: true, value: await fn() };
    } catch (err) {
        if (err instanceof GtdApiError) {
            return { ok: false, error: `${err.code ?? 'http_error'} (${err.status}): ${err.message}` };
        }
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}

function asTextResponse(payload: unknown) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function asErrorResponse(message: string) {
    return { content: [{ type: 'text' as const, text: message }], isError: true };
}

export function buildServer(client: GtdClient): McpServer {
    const server = new McpServer({ name: 'mcp-gtd', version: '0.1.0' });

    server.tool(
        'search_items',
        'Search and list GTD items belonging to the authenticated user. Returns up to `limit` items (default 50) sorted by updatedTs DESC; pass `cursor` from a previous response to paginate.',
        {
            query: z.string().optional().describe('Case-insensitive substring match against title and notes.'),
            status: z
                .string()
                .optional()
                .describe('Single status or comma-separated list (e.g. "inbox" or "inbox,nextAction"). Defaults to everything except trash.'),
            since: z.string().optional().describe('ISO datetime — only return items updated strictly after this timestamp.'),
            limit: z.number().int().min(1).max(200).optional(),
            cursor: z.string().optional().describe('Opaque cursor from a previous response\'s `nextCursor`.'),
        },
        async (args) => {
            const result = await callClient(() =>
                client.listItems({
                    ...(args.query !== undefined ? { q: args.query } : {}),
                    ...(args.status !== undefined ? { status: args.status } : {}),
                    ...(args.since !== undefined ? { since: args.since } : {}),
                    ...(args.limit !== undefined ? { limit: args.limit } : {}),
                    ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
                }),
            );
            return result.ok ? asTextResponse(result.value) : asErrorResponse(result.error);
        },
    );

    server.tool(
        'get_item',
        'Fetch a single GTD item by id.',
        { id: z.string().describe('Item _id (UUID).') },
        async (args) => {
            const result = await callClient(() => client.getItem(args.id));
            return result.ok ? asTextResponse(result.value) : asErrorResponse(result.error);
        },
    );

    server.tool(
        'create_inbox_item',
        'Capture a new GTD inbox item. Idempotent on (user, externalId) when externalId is provided; otherwise the server dedupes by content (title+notes) within a 24h window.',
        {
            title: z.string().min(1).describe('Required. Will be trimmed.'),
            notes: z.string().optional().describe('Markdown body.'),
            externalId: z.string().optional().describe('Stable dedupe key from the calling system (e.g. an email Message-Id).'),
        },
        async (args) => {
            const result = await callClient(() =>
                client.createInboxItem({
                    title: args.title,
                    ...(args.notes !== undefined ? { notes: args.notes } : {}),
                    ...(args.externalId !== undefined ? { externalId: args.externalId } : {}),
                }),
            );
            return result.ok ? asTextResponse(result.value) : asErrorResponse(result.error);
        },
    );

    server.tool(
        'complete_item',
        'Mark an item as done. Idempotent — completing an already-done item returns it unchanged.',
        { id: z.string().describe('Item _id (UUID).') },
        async (args) => {
            const result = await callClient(() => client.completeItem(args.id));
            return result.ok ? asTextResponse(result.value) : asErrorResponse(result.error);
        },
    );

    server.tool(
        'clarify_inbox_item',
        'Clarify an inbox item: set its status to nextAction, waitingFor, or somedayMaybe and attach metadata. Requires the items.clarify scope on the token.',
        {
            id: z.string().describe('Item _id (UUID).'),
            status: z.enum(['nextAction', 'waitingFor', 'somedayMaybe']).optional(),
            workContextIds: z.array(z.string()).optional(),
            peopleIds: z.array(z.string()).optional(),
            waitingForPersonId: z.string().optional(),
            energy: z.enum(['low', 'medium', 'high']).optional(),
            time: z.number().nonnegative().optional(),
            focus: z.boolean().optional(),
            urgent: z.boolean().optional(),
            expectedBy: z.string().optional(),
            ignoreBefore: z.string().optional(),
            notes: z.string().optional(),
        },
        async (args) => {
            const { id, ...rest } = args;
            const fields = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
            const result = await callClient(() => client.clarifyItem(id, fields));
            return result.ok ? asTextResponse(result.value) : asErrorResponse(result.error);
        },
    );

    server.tool(
        'bulk_import_inbox_items',
        'Bulk-import inbox items from a legacy system. Each item MUST carry an `externalId` so re-runs after a partial failure are idempotent. Returns one result per item with status: created | replayed | failed. Capped at 5,000 items per call.',
        {
            items: z
                .array(
                    z.object({
                        title: z.string().min(1),
                        externalId: z.string().min(1).describe('Stable id from the source system; the dedupe key.'),
                        notes: z.string().optional(),
                    }),
                )
                .min(1)
                .max(5_000),
            chunkSize: z.number().int().min(1).max(500).optional(),
        },
        async (args) => {
            const result = await callClient(() => client.bulkImportInboxItems(args.items, args.chunkSize));
            return result.ok ? asTextResponse(result.value) : asErrorResponse(result.error);
        },
    );

    return server;
}

async function main() {
    const config = readConfig();
    const client = new GtdClient(config);
    const server = buildServer(client);
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

// Run only when invoked as the entrypoint, not when imported by tests.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    main().catch((err) => {
        console.error('mcp-gtd failed to start:', err);
        process.exit(1);
    });
}
