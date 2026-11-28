import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { withOneLoggedInDevice, withTwoLoggedInDevices } from './helpers/context';
import { API_URL } from './helpers/env';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

// "Ask Claude" on an item. Playwright starts the API with CLAUDE_ROUTINE_FAKE=1, so starting the
// Claude routine returns `https://claude.ai/code/session_fake_<askId>` without calling Anthropic.
// Claude's report-back is played by a bearer call to the same route the MCP tool uses.

async function connectClaudeRoutine(request: APIRequestContext): Promise<void> {
    const res = await request.put(`${API_URL}/account/claude-routine`, {
        data: { claudeRoutineId: 'trig_01E2eItem', token: 'sk-ant-oat01-e2e-item-token-abcd' },
    });
    expect(res.status()).toBe(200);
}

async function reportAsClaude(request: APIRequestContext, askId: string, body: { summary: string; outcome?: 'completed' | 'needsInput' }): Promise<void> {
    const mint = await request.post(`${API_URL}/account/tokens`, { data: { label: 'claude-session', scopes: ['items.read', 'items.write'] } });
    expect(mint.status()).toBe(200);
    const { plaintext } = (await mint.json()) as { plaintext: string };
    const res = await request.put(`${API_URL}/v1/claude-asks/${askId}/result`, { headers: { Authorization: `Bearer ${plaintext}` }, data: body });
    expect(res.status()).toBe(200);
}

function promptBox(page: Page) {
    return page.getByTestId('askClaudePrompt').getByRole('textbox');
}

async function openSeededItem(page: Page, title: string): Promise<string> {
    const item = await gtd.collect(page, title);
    await gtd.flush(page); // never navigate mid-flush — see CLAUDE.md
    await page.goto(`/item/${item._id}`);
    return item._id;
}

test.describe('Ask Claude on an item', () => {
    test('asking records a waiting row with the session link; the report shows up live on another device', async ({ browser }) => {
        await withTwoLoggedInDevices(browser, `ask-claude-${uniqueStamp()}@example.com`, async (page1, page2) => {
            await connectClaudeRoutine(page1.context().request);
            const itemId = await openSeededItem(page1, 'Implement the ticket');
            await page2.goto(`/item/${itemId}`);

            await promptBox(page1).fill('Make the title readable and keep it in the inbox');
            await page1.getByTestId('askClaudeButton').click();

            const row = page1.getByTestId('askClaudeRow');
            await expect(row).toHaveCount(1);
            await expect(row).toContainText('Make the title readable and keep it in the inbox');
            await expect(row.getByTestId('askClaudeRowResult')).toHaveText("Waiting for Claude's result");
            const askId = await row.getAttribute('data-ask-id');
            if (!askId) {
                throw new Error('expected the row to carry its ask id');
            }
            await expect(row.getByTestId('askClaudeSessionLink')).toHaveAttribute('href', `https://claude.ai/code/session_fake_${askId}`);
            await expect(promptBox(page1)).toHaveValue('');
            // Server-written: the device queues nothing for it.
            expect((await gtd.queuedOps(page1)).filter((op) => op.entityType === 'claudeAsk')).toHaveLength(0);

            await reportAsClaude(page1.context().request, askId, { summary: 'Renamed it from the ticket; left it in the inbox.' });

            const row2 = page2.getByTestId('askClaudeRow');
            await expect(row2.getByTestId('askClaudeRowResult')).toHaveText('✓ Renamed it from the ticket; left it in the inbox.', { timeout: 15_000 });
            await expect(page1.getByTestId('askClaudeRowResult')).toHaveText('✓ Renamed it from the ticket; left it in the inbox.', { timeout: 15_000 });
        });
    });

    test('a needsInput report reads as a request for the user', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `ask-claude-needs-${uniqueStamp()}@example.com`, async (page) => {
            await connectClaudeRoutine(page.context().request);
            await openSeededItem(page, 'Which ticket?');
            await promptBox(page).fill('Read the ticket and rename this');
            await page.getByTestId('askClaudeButton').click();
            const row = page.getByTestId('askClaudeRow');
            const askId = await row.getAttribute('data-ask-id');
            if (!askId) {
                throw new Error('expected the row to carry its ask id');
            }

            await reportAsClaude(page.context().request, askId, { summary: 'The notes name two tickets — which one?', outcome: 'needsInput' });
            await expect(row.getByTestId('askClaudeRowResult')).toHaveText('Needs your input: The notes name two tickets — which one?', { timeout: 15_000 });
        });
    });

    test('Mod+Enter in the prompt asks Claude without saving the editor', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `ask-claude-shortcut-${uniqueStamp()}@example.com`, async (page) => {
            await connectClaudeRoutine(page.context().request);
            const itemId = await openSeededItem(page, 'Shortcut item');
            const before = await gtd.getItem(page, itemId);
            await promptBox(page).fill('Summarize this');
            await promptBox(page).press('ControlOrMeta+Enter');
            await expect(page.getByTestId('askClaudeRow')).toHaveCount(1);
            // The editor's own Mod+Enter would have saved (restamping updatedTs) and left the page.
            await expect(page).toHaveURL(new RegExp(`/item/${itemId}`));
            expect((await gtd.getItem(page, itemId))?.updatedTs).toBe(before?.updatedTs);
        });
    });

    test('without a connected Claude routine the button is disabled and links to its Settings section', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `ask-claude-unconnected-${uniqueStamp()}@example.com`, async (page) => {
            const itemId = await openSeededItem(page, 'No Claude routine yet');
            await expect(page.getByTestId('askClaudeButton')).toBeDisabled();
            await expect(page.getByTestId('askClaudePrompt')).toHaveCount(0);
            await page.getByTestId('askClaudeNotConnectedTooltipAnchor').hover();
            await expect(page.getByRole('tooltip')).toHaveText('Connect a Claude routine in Settings to ask Claude from Done');

            await page.getByTestId('askClaudeSettingsLink').click();
            await expect(page).toHaveURL(/\/settings#claude-routine$/);
            await expect(page.getByTestId('claudeRoutineSection')).toBeInViewport();

            // Connecting in Settings enables the box without waiting for the status to go stale:
            // Settings writes its answer through, so the item page re-reads nothing. In-app back
            // navigation keeps the page (and the in-memory status) — a page.goto would reload it.
            await page.getByTestId('claudeRoutineIdInput').getByRole('textbox').fill('trig_01E2eItem');
            await page.getByTestId('claudeRoutineTokenInput').getByRole('textbox').fill('sk-ant-oat01-e2e-item-token-abcd');
            await page.getByTestId('claudeRoutineSaveButton').click();
            await expect(page.getByTestId('claudeRoutineDisconnectButton')).toBeVisible();
            const statusReads: string[] = [];
            page.on('request', (req) => {
                if (req.method() === 'GET' && req.url().endsWith('/account/claude-routine')) statusReads.push(req.url());
            });
            await page.goBack();
            await expect(page).toHaveURL(new RegExp(`/item/${itemId}`));
            await expect(promptBox(page)).toBeVisible();
            expect(statusReads).toEqual([]);
        });
    });

    test('an ask refused for a missing Claude routine re-checks the connection and disables the box', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `ask-claude-unchecked-${uniqueStamp()}@example.com`, async (page) => {
            // The first status read fails, so the box starts usable (status unknown); the ask then fails.
            let isFirstRead = true;
            await page.route('**/account/claude-routine', (route) => {
                if (route.request().method() === 'GET' && isFirstRead) {
                    isFirstRead = false;
                    return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
                }
                return route.fallback();
            });
            await openSeededItem(page, 'Status unknown');
            await promptBox(page).fill('Help');
            await page.getByTestId('askClaudeButton').click();
            await expect(page.getByTestId('askClaudeSettingsLink')).toHaveAttribute('href', /\/settings#claude-routine$/);
            await expect(page.getByTestId('askClaudePrompt')).toHaveCount(0);
            await expect(page.getByTestId('askClaudeButton')).toBeDisabled();
            await expect(page.getByTestId('askClaudeRow')).toHaveCount(0);
        });
    });

    test('the Ask Claude button is disabled offline', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `ask-claude-offline-${uniqueStamp()}@example.com`, async (page) => {
            await connectClaudeRoutine(page.context().request);
            await openSeededItem(page, 'Offline item');
            await promptBox(page).fill('Help');
            await expect(page.getByTestId('askClaudeButton')).toBeEnabled();
            await page.context().setOffline(true);
            await expect(page.getByTestId('askClaudeButton')).toBeDisabled();
            await page.context().setOffline(false);
            await expect(page.getByTestId('askClaudeButton')).toBeEnabled();
        });
    });

    test('the Ask Claude box is on the Weekly Review card too', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `ask-claude-review-${uniqueStamp()}@example.com`, async (page) => {
            await connectClaudeRoutine(page.context().request);
            const item = await gtd.collect(page, 'Review me');
            await gtd.updateItem(page, { ...item, status: 'nextAction', energy: 'low', time: 5 });
            await gtd.flush(page);
            await page.route('**/maintenance/briefs/sweep-mine', (route) =>
                route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ started: 0, cooldown: true }) }),
            );
            await page.goto('/weekly-review?stage=nextActions');
            await page.getByTestId('startReviewButton').click();
            // The card's height budget keeps it a disclosure there; expanding shows the composer.
            const card = page.getByTestId('focusStage');
            await expect(card.getByTestId('askClaudePrompt')).toHaveCount(0);
            await card.getByTestId('askClaudeExpandButton').focus();
            await page.keyboard.press('Enter');
            // The disclosure button unmounts on open; focus must land in the prompt, not on <body>.
            await expect(card.getByTestId('askClaudePrompt').getByRole('textbox')).toBeFocused();
        });
    });

    test('the Weekly Review card disables Ask Claude without a Claude routine', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `ask-claude-review-off-${uniqueStamp()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Review me unconnected');
            await gtd.updateItem(page, { ...item, status: 'nextAction', energy: 'low', time: 5 });
            await gtd.flush(page);
            await page.route('**/maintenance/briefs/sweep-mine', (route) =>
                route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ started: 0, cooldown: true }) }),
            );
            await page.goto('/weekly-review?stage=nextActions');
            await page.getByTestId('startReviewButton').click();
            const card = page.getByTestId('focusStage');
            await expect(card.getByTestId('askClaudeButton')).toBeDisabled();
            await expect(card.getByTestId('askClaudeExpandButton')).toHaveCount(0);
            await expect(card.getByTestId('askClaudeSettingsLink')).toHaveAttribute('href', /\/settings#claude-routine$/);
        });
    });
});
