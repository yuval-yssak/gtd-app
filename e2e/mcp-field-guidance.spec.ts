import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { resetServerForEmails, withOneLoggedInDevice } from './helpers/context';
import { callTool, initializeMcp, McpStdioClient } from './helpers/mcpStdioClient';

const API_URL = 'http://localhost:4000';
// The CURRENT MCP package (`mcp-server/`), built by global-setup.ts. Resolved against this file's
// directory at run time so the spec works regardless of cwd.
const MCP_DIST = path.resolve(__dirname, '../mcp-server/dist/index.js');

interface GuidedItem {
    _id: string;
    status: string;
    url?: string;
    fieldGuidance?: { missing: string[]; hint: string };
}

/**
 * Field-completeness guidance end-to-end: the real stdio binary, a real bearer token, the real
 * /v1 apply pipeline. Pins that an agent which only flips `status` gets told which GTD metadata
 * is still empty (and how to fill it), and that the block vanishes once the fields are set.
 */
test.describe('MCP server field guidance (mcp-server)', () => {
    test('nudges for energy/time/context, expectedBy and location after gtd_update_item', async ({ browser }) => {
        const email = `mcp-guidance-${dayjs().valueOf()}@example.com`;
        await resetServerForEmails([email]);

        await withOneLoggedInDevice(browser, email, async (page) => {
            const mintRes = await page.context().request.post(`${API_URL}/account/tokens`, {
                data: { label: 'mcp-guidance-e2e', scopes: ['items.capture', 'items.read', 'items.write', 'contexts.write'] },
            });
            const { plaintext } = (await mintRes.json()) as { plaintext: string };

            const mcp = new McpStdioClient({ distPath: MCP_DIST, env: { GTD_API_BASE: API_URL, GTD_API_TOKEN: plaintext } });
            try {
                // The rule is advertised up front, so a model learns it before its first write.
                const init = await initializeMcp(mcp);
                expect(init.result?.instructions).toContain('fieldGuidance');

                // 1. Capture lands in inbox — no metadata expected, no guidance.
                const captured = (await callTool(mcp, 'gtd_capture', { title: 'Book dentist appointment' })) as GuidedItem;
                expect(captured.status).toBe('inbox');
                expect(captured.fieldGuidance).toBeUndefined();

                // 2. Status-only clarify to nextAction → all three Do-phase fields flagged, next to the url.
                const bare = (await callTool(mcp, 'gtd_update_item', { id: captured._id, status: 'nextAction' })) as GuidedItem;
                expect(bare.status).toBe('nextAction');
                expect(bare.url).toContain(`/item/${captured._id}`);
                expect(bare.fieldGuidance?.missing).toEqual(['energy', 'time', 'workContextIds']);
                expect(bare.fieldGuidance?.hint).toContain('gtd_list_work_contexts');

                // 3. Fill them in (with a real work context) → the block disappears.
                const office = (await callTool(mcp, 'gtd_create_work_context', { name: 'Office' })) as { _id: string };
                const complete = (await callTool(mcp, 'gtd_update_item', {
                    id: captured._id,
                    energy: 'low',
                    time: 10,
                    workContextIds: [office._id],
                })) as GuidedItem;
                expect(complete.fieldGuidance).toBeUndefined();

                // 4. Delegating it → expectedBy is the one thing a waitingFor needs.
                const waiting = (await callTool(mcp, 'gtd_update_item', { id: captured._id, status: 'waitingFor' })) as GuidedItem;
                expect(waiting.fieldGuidance?.missing).toEqual(['expectedBy']);
                const dated = (await callTool(mcp, 'gtd_update_item', {
                    id: captured._id,
                    expectedBy: dayjs().add(7, 'day').format('YYYY-MM-DD'),
                })) as GuidedItem;
                expect(dated.fieldGuidance).toBeUndefined();

                // 5. Scheduling it → no Google Calendar is connected in e2e, so the item stays unlinked and
                //    the location rule must NOT fire (there is no Google event to set a location on). The
                //    linked case is covered by the api-server /mcp test, which seeds the link directly.
                const start = dayjs().add(1, 'day').hour(10).minute(0).second(0).millisecond(0);
                const scheduled = (await callTool(mcp, 'gtd_update_item', {
                    id: captured._id,
                    status: 'calendar',
                    expectedBy: null,
                    timeStart: start.format('YYYY-MM-DDTHH:mm:ss'),
                    timeEnd: start.add(30, 'minute').format('YYYY-MM-DDTHH:mm:ss'),
                })) as GuidedItem;
                expect(scheduled.status).toBe('calendar');
                expect(scheduled.fieldGuidance).toBeUndefined();
            } finally {
                mcp.close();
            }
        });
    });
});
