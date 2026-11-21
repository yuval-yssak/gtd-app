import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ApiClient } from '../apiClient.js';
import { registerAllTools } from '../tools/catalog.js';
import type { ToolSafety } from '../tools/types.js';

/**
 * What an MCP client sees in `tools/list`, per surface. The Claude connector directory rejects a
 * server whose tools lack a title or safety annotations, or that lists a tool which cannot succeed,
 * so the whole catalog is pinned here rather than tool by tool.
 */

interface ListedTool {
    name: string;
    title: string;
    description: string;
    annotations: ToolSafety;
    properties: Record<string, unknown>;
}

interface RegisteredConfig {
    title: string;
    description: string;
    inputSchema: z.ZodRawShape;
    annotations: ToolSafety;
}

function fakeApi(supportsMultipleAccounts: boolean): ApiClient {
    return {
        request: async () => ({}) as never,
        listAccounts: () => ['default'],
        supportsMultipleAccounts: () => supportsMultipleAccounts,
        environment: () => 'local',
        apiBase: () => 'http://localhost:4000',
        webBase: () => null,
    };
}

function listTools(surface: 'multiAccount' | 'singleAccount'): ListedTool[] {
    const listed: ListedTool[] = [];
    const server = {
        registerTool: (name: string, config: RegisteredConfig) => {
            const schema = z.toJSONSchema(z.object(config.inputSchema), { io: 'input' }) as { properties?: Record<string, unknown> };
            listed.push({ name, title: config.title, description: config.description, annotations: config.annotations, properties: schema.properties ?? {} });
        },
    };
    // biome-ignore lint/suspicious/noExplicitAny: the stub matches registerOne's structural McpServer use.
    registerAllTools(server as any as McpServer, fakeApi(surface === 'multiAccount'));
    return listed;
}

const namesWhere = (tools: ListedTool[], matches: (tool: ListedTool) => boolean) =>
    tools
        .filter(matches)
        .map((tool) => tool.name)
        .sort();

const READ_ONLY_TOOLS = [
    'done_get_item',
    'done_get_person',
    'done_get_routine',
    'done_get_work_context',
    'done_list_accounts',
    'done_list_items',
    'done_list_people',
    'done_list_routines',
    'done_list_work_contexts',
    'done_me',
];

// Writes that only add a new row; every other write changes or removes existing data.
const ADDITIVE_TOOLS = ['done_capture', 'done_create_person', 'done_create_routine', 'done_create_work_context'];

// Not here: the creates (a repeat adds a row), done_batch, done_reassign, done_generate_brief (model output
// varies), done_split_routine (each call cuts a new tail) and done_resume_routine (restamps the start date).
const IDEMPOTENT_WRITES = [
    'done_complete_item',
    'done_delete_person',
    'done_delete_routine',
    'done_delete_work_context',
    'done_move_item',
    'done_pause_routine',
    'done_report_claude_ask',
    'done_set_brief',
    'done_trash_item',
    'done_update_item',
    'done_update_person',
    'done_update_routine',
    'done_update_work_context',
];

const MULTI_ACCOUNT_ONLY_TOOLS = ['done_list_accounts', 'done_reassign'];

describe('tool catalog', () => {
    const tools = listTools('multiAccount');

    it('gives every tool a short human-readable title', () => {
        for (const tool of tools) {
            expect(tool.title, tool.name).toMatch(/^[A-Z][\w /-]{2,40}$/);
            expect(tool.title, tool.name).not.toContain('gtd');
        }
        expect(new Set(tools.map((tool) => tool.title)).size).toBe(tools.length);
    });

    it('names every tool after the product, within the 64-character directory limit', () => {
        for (const tool of tools) {
            expect(tool.name).toMatch(/^done_[a-z_]{1,59}$/);
        }
    });

    it('declares all four safety hints on every tool', () => {
        for (const tool of tools) {
            expect(Object.keys(tool.annotations).sort(), tool.name).toEqual(['destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint']);
            expect(tool.annotations.openWorldHint, tool.name).toBe(false);
        }
    });

    it('marks exactly the list / get / identity tools read-only', () => {
        expect(namesWhere(tools, (tool) => tool.annotations.readOnlyHint)).toEqual(READ_ONLY_TOOLS);
    });

    it('marks every write destructive unless it only adds a new row', () => {
        expect(namesWhere(tools, (tool) => !tool.annotations.readOnlyHint && !tool.annotations.destructiveHint)).toEqual(ADDITIVE_TOOLS);
        expect(namesWhere(tools, (tool) => tool.annotations.readOnlyHint && tool.annotations.destructiveHint)).toEqual([]);
    });

    it('calls a write idempotent only where a repeat leaves the same state', () => {
        expect(namesWhere(tools, (tool) => tool.annotations.idempotentHint && !tool.annotations.readOnlyHint)).toEqual(IDEMPOTENT_WRITES);
        expect(namesWhere(tools, (tool) => tool.annotations.readOnlyHint && !tool.annotations.idempotentHint)).toEqual([]);
    });
});

describe('single-account surface (the hosted connector)', () => {
    const multi = listTools('multiAccount');
    const single = listTools('singleAccount');

    it('lists every tool except the ones that need a second account', () => {
        const multiNames = multi.map((tool) => tool.name);
        const singleNames = single.map((tool) => tool.name);
        expect(multiNames.filter((name) => !singleNames.includes(name)).sort()).toEqual(MULTI_ACCOUNT_ONLY_TOOLS);
        expect(singleNames.filter((name) => !multiNames.includes(name))).toEqual([]);
    });

    it('offers no `account` argument, which could only ever be "default"', () => {
        for (const tool of single) {
            expect(Object.keys(tool.properties), tool.name).not.toContain('account');
        }
        expect(Object.keys(multi.find((tool) => tool.name === 'done_capture')?.properties ?? {})).toContain('account');
    });

    it('describes no token env vars or account labels', () => {
        for (const tool of single) {
            expect(tool.description, tool.name).not.toMatch(/GTD_API_TOKEN|`account`/);
        }
        expect(multi.find((tool) => tool.name === 'done_me')?.description).toContain('`account`');
    });

    it('is otherwise identical to the multi-account surface', () => {
        const withoutAccount = ({ account: _account, ...rest }: Record<string, unknown>) => rest;
        for (const tool of single.filter((listed) => listed.name !== 'done_me')) {
            const twin = multi.find((candidate) => candidate.name === tool.name);
            if (!twin) throw new Error(`no multi-account twin for ${tool.name}`);
            expect({ ...tool, properties: withoutAccount(tool.properties) }).toEqual({ ...twin, properties: withoutAccount(twin.properties) });
        }
    });
});
