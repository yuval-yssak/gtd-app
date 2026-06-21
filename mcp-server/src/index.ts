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
    'After creating or editing an item or routine, item and routine tool responses include a `url` field — a direct',
    'web-app link to that entity. Always show the user this `url` at the end of your reply so they can jump straight to it.',
    'The `gtd_batch` tool returns only `{ ok, count }` with no entity, so it carries no `url`; when a batch creates or',
    'updates items/routines, construct the link yourself from each op as `<web-app-origin>/item/<entityId>` or',
    '`<web-app-origin>/routine/<entityId>` (infer the origin from a `url` returned by any other tool in the session).',
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
