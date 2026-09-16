/**
 * Parity guard for the copied MCP tool modules. The remote `/mcp` server serves a COPY of the tool
 * code that physically lives in mcp-server/src (the stdio binary's source of truth) — see
 * api-server/src/mcp/*. This test registers every tool group from BOTH copies against a stub server
 * and asserts the exposed tool-name sets are identical, so the copies can never silently drift.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
// The stdio binary's source-of-truth copies (relative import across packages — test-only, never bundled).
import { registerBatchTools } from '../../../mcp-server/src/tools/batch.js';
import { registerItemTools } from '../../../mcp-server/src/tools/items.js';
import { registerMeTools } from '../../../mcp-server/src/tools/me.js';
import { registerPeopleTools } from '../../../mcp-server/src/tools/people.js';
import { registerReassignTools } from '../../../mcp-server/src/tools/reassign.js';
import { registerRoutineTools } from '../../../mcp-server/src/tools/routines.js';
import { registerWorkContextTools } from '../../../mcp-server/src/tools/workContexts.js';
import type { ApiClient } from '../mcp/apiClient.js';
import { registerAllTools } from '../mcp/registerTools.js';

interface RegisteredTool {
    name: string;
    description: string;
    /** Input schema serialized to JSON Schema — the wire shape an MCP client actually sees. */
    inputSchema: unknown;
}

/**
 * Captures every `server.registerTool(name, config, ...)` call — the only method our tools call.
 * The input schema is serialized to JSON Schema so a `.nullable()` / `.describe()` drift between
 * the two copies fails here instead of only surfacing to a model at runtime.
 */
function captureTools(register: (server: McpServer, api: ApiClient) => void): RegisteredTool[] {
    const tools: RegisteredTool[] = [];
    const stub = {
        registerTool: (name: string, config: { description: string; inputSchema: z.ZodRawShape }) =>
            tools.push({ name, description: config.description, inputSchema: z.toJSONSchema(z.object(config.inputSchema), { io: 'input' }) }),
    } as unknown as McpServer;
    // A no-op ApiClient — registration never invokes handlers, so the methods are never called.
    const api = {} as ApiClient;
    register(stub, api);
    return tools.sort((a, b) => a.name.localeCompare(b.name));
}

function captureToolNames(register: (server: McpServer, api: ApiClient) => void): string[] {
    return captureTools(register).map((tool) => tool.name);
}

describe('MCP tool parity (api-server copy ↔ mcp-server source of truth)', () => {
    it('exposes the identical set of tool names from both copies', () => {
        const remote = captureToolNames(registerAllTools);
        const stdio = captureToolNames((server, api) => {
            registerItemTools(server, api);
            registerRoutineTools(server, api);
            registerPeopleTools(server, api);
            registerWorkContextTools(server, api);
            registerReassignTools(server, api);
            registerBatchTools(server, api);
            registerMeTools(server, api);
        });
        expect(remote).toEqual(stdio);
        // Sanity: the full GTD surface is present (guards against both copies being empty).
        expect(remote).toContain('gtd_capture');
        expect(remote).toContain('gtd_reassign');
        expect(remote.length).toBeGreaterThanOrEqual(28);
    });

    it('exposes identical descriptions and input JSON Schemas from both copies', () => {
        const remote = captureTools(registerAllTools);
        const stdio = captureTools((server, api) => {
            registerItemTools(server, api);
            registerRoutineTools(server, api);
            registerPeopleTools(server, api);
            registerWorkContextTools(server, api);
            registerReassignTools(server, api);
            registerBatchTools(server, api);
            registerMeTools(server, api);
        });
        expect(remote).toEqual(stdio);
    });
});
