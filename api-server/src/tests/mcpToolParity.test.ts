/**
 * Parity guard for the copied MCP tool modules. The remote `/mcp` server serves a COPY of the tool
 * code that physically lives in mcp-server/src (the stdio binary's source of truth) — see
 * api-server/src/mcp/*. This test registers every tool group from BOTH copies against a stub server
 * and asserts the exposed tool-name sets are identical, so the copies can never silently drift.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SERVER_INSTRUCTIONS as STDIO_SERVER_INSTRUCTIONS } from '../../../mcp-server/src/serverInstructions.js';
// The stdio binary's source-of-truth copies (relative import across packages — test-only, never bundled).
import { registerAllTools as registerStdioTools } from '../../../mcp-server/src/tools/catalog.js';
import type { ApiClient } from '../mcp/apiClient.js';
import { SERVER_INSTRUCTIONS as REMOTE_SERVER_INSTRUCTIONS, registerAllTools } from '../mcp/registerTools.js';

/** The stdio binary can hold a token per account; the hosted connector is one signed-in account. */
type Surface = 'multiAccount' | 'singleAccount';
const SURFACES: Surface[] = ['multiAccount', 'singleAccount'];

interface RegisteredTool {
    name: string;
    title: string;
    description: string;
    annotations: unknown;
    /** Input schema serialized to JSON Schema — the wire shape an MCP client actually sees. */
    inputSchema: unknown;
}

/**
 * Captures every `server.registerTool(name, config, ...)` call — the only method our tools call.
 * The input schema is serialized to JSON Schema so a `.nullable()` / `.describe()` drift between
 * the two copies fails here instead of only surfacing to a model at runtime.
 */
function captureTools(register: (server: McpServer, api: ApiClient) => void, surface: Surface = 'multiAccount'): RegisteredTool[] {
    const tools: RegisteredTool[] = [];
    const stub = {
        registerTool: (name: string, config: { title: string; description: string; inputSchema: z.ZodRawShape; annotations: unknown }) =>
            tools.push({
                name,
                title: config.title,
                description: config.description,
                annotations: config.annotations,
                inputSchema: z.toJSONSchema(z.object(config.inputSchema), { io: 'input' }),
            }),
    } as unknown as McpServer;
    // Registration never invokes handlers, so the surface is the only thing it asks the client.
    const api = { supportsMultipleAccounts: () => surface === 'multiAccount' } as ApiClient;
    register(stub, api);
    return tools.sort((a, b) => a.name.localeCompare(b.name));
}

function captureToolNames(register: (server: McpServer, api: ApiClient) => void, surface: Surface = 'multiAccount'): string[] {
    return captureTools(register, surface).map((tool) => tool.name);
}

describe('MCP tool parity (api-server copy ↔ mcp-server source of truth)', () => {
    it.each(SURFACES)('exposes the identical set of tool names from both copies (%s)', (surface) => {
        const remote = captureToolNames(registerAllTools, surface);
        expect(remote).toEqual(captureToolNames(registerStdioTools, surface));
        // Sanity: the full GTD surface is present (guards against both copies being empty).
        expect(remote).toContain('done_capture');
        expect(remote.length).toBeGreaterThanOrEqual(28);
    });

    it.each(SURFACES)('exposes identical titles, descriptions, annotations and input JSON Schemas from both copies (%s)', (surface) => {
        expect(captureTools(registerAllTools, surface)).toEqual(captureTools(registerStdioTools, surface));
    });

    // A cross-account move needs a second token, which a hosted connection never has.
    it('lists done_reassign only where several accounts can be configured', () => {
        expect(captureToolNames(registerAllTools, 'multiAccount')).toContain('done_reassign');
        expect(captureToolNames(registerAllTools, 'singleAccount')).not.toContain('done_reassign');
    });

    it('serves identical server instructions from both copies', () => {
        expect(REMOTE_SERVER_INSTRUCTIONS).toEqual(STDIO_SERVER_INSTRUCTIONS);
        expect(REMOTE_SERVER_INSTRUCTIONS).toContain('done_set_brief');
        expect(REMOTE_SERVER_INSTRUCTIONS).toContain('fieldGuidance');
    });

    // The sweep is the preferred brief source; an agent-authored brief is pinned and goes stale.
    it('steers agents away from writing briefs themselves', () => {
        expect(REMOTE_SERVER_INSTRUCTIONS).toContain('Do NOT set or generate briefs');
        expect(REMOTE_SERVER_INSTRUCTIONS).not.toContain('Prefer setting');
        const tools = new Map(captureTools(registerAllTools).map((tool) => [tool.name, tool.description]));
        expect(tools.get('done_set_brief')).toMatch(/^Normally do NOT call this/);
        expect(tools.get('done_generate_brief')).toContain('Normally unnecessary');
        expect(tools.get('done_generate_brief')).not.toContain('Prefer done_set_brief');
    });

    // Registration-level parity above cannot see response decoration (url stamping, field
    // guidance) — that code only runs when a tool is called. Comparing the copied modules' text
    // catches drift in those paths too, and flags a module added to one side only.
    it('keeps every copied module byte-identical to its source apart from the COPIED header', () => {
        const remoteDir = fileURLToPath(new URL('../mcp/tools', import.meta.url));
        const stdioDir = fileURLToPath(new URL('../../../mcp-server/src/tools', import.meta.url));
        const remoteFiles = fs.readdirSync(remoteDir).sort();
        expect(remoteFiles).toEqual(fs.readdirSync(stdioDir).sort());
        for (const file of remoteFiles) {
            const [header, ...body] = fs.readFileSync(path.join(remoteDir, file), 'utf8').split('\n');
            expect(header, file).toMatch(/^\/\/ COPIED from mcp-server\/src\/tools\//);
            expect(body.join('\n'), file).toEqual(fs.readFileSync(path.join(stdioDir, file), 'utf8'));
        }
    });
});
