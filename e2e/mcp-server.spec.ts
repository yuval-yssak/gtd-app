import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { resetServerForEmails, withOneLoggedInDevice } from './helpers/context';
import { callTool, initializeMcp, McpStdioClient } from './helpers/mcpStdioClient';

const API_URL = 'http://localhost:4000';
// Resolved against this file's directory at run time so the spec works regardless of cwd.
// This spec covers the SUPERSEDED four-tool binary (see the root CLAUDE.md); the current
// `mcp-server` package is exercised by mcp-field-guidance.spec.ts with the same client.
const MCP_DIST = path.resolve(__dirname, '../tools/mcp-gtd/dist/index.js');

/** The legacy binary reads its API base from `GTD_API_BASE_URL` (already including `/v1`). */
const spawnLegacyMcp = (token: string) => new McpStdioClient({ distPath: MCP_DIST, env: { GTD_API_BASE_URL: `${API_URL}/v1`, GTD_API_TOKEN: token } });

test.describe('MCP server (mcp-gtd)', () => {
    test('drives the four tools end-to-end against a real /v1 server', async ({ browser }) => {
        const email = `mcp-${dayjs().valueOf()}@example.com`;
        await resetServerForEmails([email]);

        await withOneLoggedInDevice(browser, email, async (page) => {
            // Mint a real bearer token via the page's session.
            // The MCP spec exercises every tool, including complete (items.write) and bulk (items.capture).
            const mintRes = await page.context().request.post(`${API_URL}/account/tokens`, {
                data: { label: 'mcp-e2e', scopes: ['items.capture', 'items.read', 'items.write'] },
            });
            const { plaintext } = (await mintRes.json()) as { plaintext: string };

            const mcp = spawnLegacyMcp(plaintext);
            try {
                await initializeMcp(mcp);

                // 1. create_inbox_item — returns the created item.
                const created = (await callTool(mcp, 'create_inbox_item', { title: 'From MCP', externalId: 'mcp-1' })) as {
                    _id: string;
                    title: string;
                    status: string;
                };
                expect(created.title).toBe('From MCP');
                expect(created.status).toBe('inbox');

                // 2. search_items — should return the item we just created.
                const search = (await callTool(mcp, 'search_items', { status: 'inbox', limit: 50 })) as {
                    items: Array<{ _id: string; title: string }>;
                };
                expect(search.items.some((i) => i._id === created._id)).toBe(true);

                // 3. get_item — fetches the item by id.
                const got = (await callTool(mcp, 'get_item', { id: created._id })) as { _id: string; title: string };
                expect(got._id).toBe(created._id);
                expect(got.title).toBe('From MCP');

                // 4. complete_item — transitions to done.
                const completed = (await callTool(mcp, 'complete_item', { id: created._id })) as { _id: string; status: string };
                expect(completed.status).toBe('done');

                // 5. bulk_import_inbox_items — capture three items in one tool call, all created.
                const bulk = (await callTool(mcp, 'bulk_import_inbox_items', {
                    items: [
                        { title: 'Bulk A', externalId: 'mcp-bulk-a' },
                        { title: 'Bulk B', externalId: 'mcp-bulk-b' },
                        { title: 'Bulk C', externalId: 'mcp-bulk-c' },
                    ],
                })) as { counts: { created: number; replayed: number; failed: number } };
                expect(bulk.counts).toEqual({ created: 3, replayed: 0, failed: 0 });
            } finally {
                mcp.close();
            }
        });
    });
});
