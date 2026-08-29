#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApiClient } from './apiClient.js';
import { loadConfig } from './config.js';
import { registerBatchTools } from './tools/batch.js';
import { registerItemTools } from './tools/items.js';
import { registerMeTools } from './tools/me.js';
import { registerPeopleTools } from './tools/people.js';
import { registerReassignTools } from './tools/reassign.js';
import { registerRoutineTools } from './tools/routines.js';
import { registerWorkContextTools } from './tools/workContexts.js';

/**
 * Stdio entrypoint. Reads GTD_API_BASE / GTD_API_TOKEN from env (set by the MCP client config),
 * registers every tool, and connects the stdio transport. The MCP client owns the process
 * lifecycle.
 */

/**
 * Server-level usage guidance surfaced to every MCP client. Lives here (not in any user's local
 * memory) so the URL-surfacing behaviour ships with the server and works for all operators.
 */
const SERVER_INSTRUCTIONS = [
    'After creating or editing an item, routine or person, the tool response includes a `url` field — a direct',
    'web-app link to that entity. Always show the user this `url` at the end of your reply so they can jump straight to it.',
    'The `gtd_batch` tool returns per-op `results`, each carrying the server-stamped `updatedTs`, an `applyStatus`, and',
    'a `url` for item/routine/person writes — surface those `url`s the same way, and check `applyStatus` instead of',
    'assuming every op landed (`skipped_missing` = the target row no longer exists).',
    'When creating or updating a person, put contact details in the dedicated `email` and `phone` fields — never bury',
    'them in `notes`.',
    'Every `notes` field (on items, routines and people) is rendered as Markdown in the web app. Always write links there',
    'as Markdown links — `[descriptive label](https://example.com)` — never a bare URL. Prefer a label that says what the',
    'link is (page title, ticket key, sender + subject); fall back to the domain when nothing better is available.',
].join(' ');

async function main(): Promise<void> {
    const config = loadConfig();
    const api = createApiClient(config);

    const server = new McpServer(
        {
            name: 'gtd-mcp',
            version: '0.1.0',
        },
        { instructions: SERVER_INSTRUCTIONS },
    );

    registerItemTools(server, api);
    registerRoutineTools(server, api);
    registerPeopleTools(server, api);
    registerWorkContextTools(server, api);
    registerReassignTools(server, api);
    registerBatchTools(server, api);
    registerMeTools(server, api);

    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((err) => {
    // Fatal startup error — log to stderr (stdout is reserved for the MCP transport) and exit.
    process.stderr.write(`gtd-mcp fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
});
