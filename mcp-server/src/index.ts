#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApiClient } from './apiClient.js';
import { loadConfig } from './config.js';
import { SERVER_INSTRUCTIONS } from './serverInstructions.js';
import { registerAllTools } from './tools/catalog.js';

/**
 * Stdio entrypoint. Reads GTD_API_BASE / GTD_API_TOKEN from env (set by the MCP client config),
 * registers every tool, and connects the stdio transport. The MCP client owns the process
 * lifecycle.
 */

async function main(): Promise<void> {
    const config = loadConfig();
    const api = createApiClient(config);

    const server = new McpServer(
        {
            name: 'done-mcp',
            title: 'Done',
            version: '0.1.0',
        },
        { instructions: SERVER_INSTRUCTIONS },
    );

    registerAllTools(server, api);

    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((err) => {
    // Fatal startup error — log to stderr (stdout is reserved for the MCP transport) and exit.
    process.stderr.write(`done-mcp fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
});
