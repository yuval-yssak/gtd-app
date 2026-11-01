import * as path from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { resetServerForEmails, withOneLoggedInDevice } from './helpers/context';
import { API_URL, CLIENT_URL } from './helpers/env';
import { callTool, initializeMcp, McpStdioClient } from './helpers/mcpStdioClient';
import { uniqueStamp } from './helpers/uniqueStamp';

// The CURRENT MCP package (`mcp-server/`), built by global-setup.ts.
const MCP_DIST = path.resolve(__dirname, '../mcp-server/dist/index.js');

interface MovedItem {
    _id: string;
    url?: string;
    placement?: { position: number; total: number };
}

const rowTitles = async (page: Page) => (await page.getByTestId('nextActionItemRow').allInnerTexts()).map((t) => t.split('\n')[0]?.trim() ?? '');

/** Captures each title and clarifies it into an undated nextAction; each clarify lands on top, so the list reads in reverse. */
async function seedNextActions(mcp: McpStdioClient, titles: readonly string[]): Promise<Record<string, string>> {
    const entries: Array<[string, string]> = [];
    // Sequential on purpose: each clarify must mint its key after the previous one, or the seeded order is arbitrary.
    for (const title of titles) {
        const captured = (await callTool(mcp, 'gtd_capture', { title })) as { _id: string };
        await callTool(mcp, 'gtd_update_item', { id: captured._id, status: 'nextAction', energy: 'low', time: 5 });
        entries.push([title, captured._id]);
    }
    return Object.fromEntries(entries);
}

function idOf(ids: Record<string, string>, title: string): string {
    const id = ids[title];
    if (!id) throw new Error(`no seeded item titled ${title}`);
    return id;
}

/**
 * Priority order changed through the MCP (`gtd_move_item` → `POST /v1/items/:id/move`) is the
 * order the Next Actions page shows: the real stdio binary, a real bearer token, the real apply
 * pipeline and sync into the browser's IndexedDB.
 */
test.describe('MCP gtd_move_item', () => {
    test('top, bottom, before and after reorder the Next Actions list', async ({ browser }) => {
        const email = `mcp-move-${uniqueStamp()}@example.com`;
        await resetServerForEmails([email]);

        await withOneLoggedInDevice(browser, email, async (page) => {
            const mintRes = await page.context().request.post(`${API_URL}/account/tokens`, {
                data: { label: 'mcp-move-e2e', scopes: ['items.capture', 'items.read', 'items.write'] },
            });
            const { plaintext } = (await mintRes.json()) as { plaintext: string };
            const mcp = new McpStdioClient({ distPath: MCP_DIST, env: { GTD_API_BASE: API_URL, GTD_API_TOKEN: plaintext } });
            try {
                await initializeMcp(mcp);
                const ids = await seedNextActions(mcp, ['Charlie', 'Bravo', 'Alpha']);

                await page.goto(`${CLIENT_URL}/next-actions`);
                await expect.poll(() => rowTitles(page)).toEqual(['Alpha', 'Bravo', 'Charlie']);

                const toTop = (await callTool(mcp, 'gtd_move_item', { id: idOf(ids, 'Charlie'), position: 'top' })) as MovedItem;
                expect(toTop.placement).toEqual({ position: 1, total: 3 });
                expect(toTop.url).toContain(`/item/${idOf(ids, 'Charlie')}`);
                await expect.poll(() => rowTitles(page)).toEqual(['Charlie', 'Alpha', 'Bravo']);

                await callTool(mcp, 'gtd_move_item', { id: idOf(ids, 'Charlie'), position: 'bottom' });
                await expect.poll(() => rowTitles(page)).toEqual(['Alpha', 'Bravo', 'Charlie']);

                await callTool(mcp, 'gtd_move_item', { id: idOf(ids, 'Charlie'), before: idOf(ids, 'Bravo') });
                await expect.poll(() => rowTitles(page)).toEqual(['Alpha', 'Charlie', 'Bravo']);

                const after = (await callTool(mcp, 'gtd_move_item', { id: idOf(ids, 'Alpha'), after: idOf(ids, 'Bravo') })) as MovedItem;
                expect(after.placement).toEqual({ position: 3, total: 3 });
                await expect.poll(() => rowTitles(page)).toEqual(['Charlie', 'Bravo', 'Alpha']);

                // The order survives a reload — it is persisted, not just an optimistic render.
                await page.reload();
                await expect.poll(() => rowTitles(page)).toEqual(['Charlie', 'Bravo', 'Alpha']);

                // gtd_list_items reads back the same order the page shows — its default is priority order.
                const listed = (await callTool(mcp, 'gtd_list_items', { status: 'nextAction' })) as { items: Array<{ title: string }> };
                expect(listed.items.map((row) => row.title)).toEqual(['Charlie', 'Bravo', 'Alpha']);
            } finally {
                mcp.close();
            }
        });
    });

    test('moving past rows that have no rank yet re-keys them and the app shows the requested order', async ({ browser }) => {
        const email = `mcp-move-unranked-${uniqueStamp()}@example.com`;
        await resetServerForEmails([email]);

        await withOneLoggedInDevice(browser, email, async (page) => {
            const sessionRes = await page.context().request.get(`${API_URL}/auth/get-session`);
            const { user } = (await sessionRes.json()) as { user: { id: string } };
            const mintRes = await page.context().request.post(`${API_URL}/account/tokens`, {
                data: { label: 'mcp-move-unranked-e2e', scopes: ['items.capture', 'items.read', 'items.write'] },
            });
            const { plaintext } = (await mintRes.json()) as { plaintext: string };
            const mcp = new McpStdioClient({ distPath: MCP_DIST, env: { GTD_API_BASE: API_URL, GTD_API_TOKEN: plaintext } });
            try {
                await initializeMcp(mcp);
                const ranked = await seedNextActions(mcp, ['Ranked']);
                // Batch creates are never minted a rank: both sort above "Ranked", newest first.
                const stamp = uniqueStamp();
                const unranked = (title: string, createdTs: string) => {
                    const id = `mcp-move-${title.toLowerCase()}-${stamp}`;
                    const snapshot = { _id: id, user: user.id, status: 'nextAction', title, energy: 'low', time: 5, createdTs, updatedTs: createdTs };
                    return { entityType: 'item', opType: 'create', entityId: id, snapshot };
                };
                const now = dayjs();
                await callTool(mcp, 'gtd_batch', {
                    ops: [unranked('Older', now.subtract(2, 'minute').toISOString()), unranked('Newer', now.subtract(1, 'minute').toISOString())],
                });

                await page.goto(`${CLIENT_URL}/next-actions`);
                await expect.poll(() => rowTitles(page)).toEqual(['Newer', 'Older', 'Ranked']);

                const moved = (await callTool(mcp, 'gtd_move_item', { id: idOf(ranked, 'Ranked'), after: `mcp-move-newer-${stamp}` })) as MovedItem;
                expect(moved.placement).toEqual({ position: 2, total: 3 });
                await expect.poll(() => rowTitles(page)).toEqual(['Newer', 'Ranked', 'Older']);

                await page.reload();
                await expect.poll(() => rowTitles(page)).toEqual(['Newer', 'Ranked', 'Older']);
                const listed = (await callTool(mcp, 'gtd_list_items', { status: 'nextAction' })) as { items: Array<{ title: string }> };
                expect(listed.items.map((row) => row.title)).toEqual(['Newer', 'Ranked', 'Older']);
            } finally {
                mcp.close();
            }
        });
    });
});
