import { expect, type Page, type Route, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

/**
 * Client review→apply UX for Lane A "Clarify with Claude" (issue #21, Phase 5).
 *
 * The agent loop calls the real Anthropic API (not available in CI), so both assist endpoints are
 * intercepted at the NETWORK layer with canned JSON via `page.route`. The apply route is also
 * fulfilled (no real op-log write), so these tests assert the CLIENT behaviour — the sheet renders,
 * the right request bodies are sent, error copy appears — not server/IDB state. Deterministic, no key.
 *
 * The deploy-level guard paths (auth, CORS, scope, validation) live in `claude-assist.spec.ts`.
 */

const ASSIST_GLOB = '**/v1/claude/assist';
const APPLY_GLOB = '**/v1/claude/assist/apply';

/** Fulfils a route with a JSON body + status. */
function fulfillJson(route: Route, body: unknown, status = 200) {
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** Seeds an inbox item + a work context, then opens the inbox page with the item rendered. */
async function seedInboxAndOpen(page: Page, title: string) {
    const context = await gtd.createWorkContext(page, '@phone');
    const item = await gtd.collect(page, title);
    await page.goto('/inbox');
    await page.waitForSelector(`text=${title}`);
    return { item, contextId: context._id };
}

/** A canned proposal referencing a real seeded context id so the presenter resolves it to a name. */
function cannedProposal(contextId: string) {
    return {
        summary: 'Turn this into a next action.',
        proposedItemPatch: { title: 'Follow up with Dana on the deck', status: 'nextAction', workContextIds: [contextId] },
        proposedSideEffects: [{ kind: 'itemPatch', preview: 'Update the item', executeToken: 'canned.execute.token' }],
    };
}

test.describe('Lane A Claude review→apply flow (client UI, mocked endpoints)', () => {
    test('clarify renders the proposal, then Apply sends the token + patch and closes', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `claude-flow-${dayjs().valueOf()}@example.com`, async (page) => {
            const { contextId } = await seedInboxAndOpen(page, 'ask dana for the deck');
            await page.route(ASSIST_GLOB, (route) => fulfillJson(route, cannedProposal(contextId)));

            let applyBody: { executeToken?: string; patch?: { title?: string } } | null = null;
            await page.route(APPLY_GLOB, async (route) => {
                applyBody = route.request().postDataJSON();
                await fulfillJson(route, { applied: true, item: { id: 'x', status: 'nextAction', title: 'Follow up with Dana on the deck' } });
            });

            await page.getByTestId('inboxItemClarifyClaudeButton').first().click();
            await expect(page.getByTestId('claudeReviewSheet')).toBeVisible();
            await expect(page.getByTestId('claudeReviewSummary')).toContainText('next action');
            // Humanized fields: the status label and the resolved context name both render.
            await expect(page.getByTestId('claudeReviewSheet')).toContainText('Next Action');
            await expect(page.getByTestId('claudeReviewSheet')).toContainText('@phone');

            await page.getByTestId('claudeReviewApply').click();
            await expect(page.getByTestId('claudeReviewSheet')).toBeHidden();
            expect(applyBody?.executeToken).toBe('canned.execute.token');
            expect(applyBody?.patch?.title).toBe('Follow up with Dana on the deck');
        });
    });

    test('editing the title in place applies the edited value on the SAME token', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `claude-edit-${dayjs().valueOf()}@example.com`, async (page) => {
            const { contextId } = await seedInboxAndOpen(page, 'edit me');
            await page.route(ASSIST_GLOB, (route) => fulfillJson(route, cannedProposal(contextId)));

            let applyBody: { executeToken?: string; patch?: { title?: string } } | null = null;
            await page.route(APPLY_GLOB, async (route) => {
                applyBody = route.request().postDataJSON();
                await fulfillJson(route, { applied: true, item: { id: 'x', status: 'nextAction', title: 'my own title' } });
            });

            await page.getByTestId('inboxItemClarifyClaudeButton').first().click();
            await page.getByTestId('claudeReviewEdit').click();
            const titleInput = page.getByTestId('claudeReviewEditInput-title');
            await titleInput.fill('my own title');
            await page.getByTestId('claudeReviewApply').click();

            await expect(page.getByTestId('claudeReviewSheet')).toBeHidden();
            expect(applyBody?.patch?.title).toBe('my own title');
            // The token is unchanged — editing the payload (not the target) reuses the same grant.
            expect(applyBody?.executeToken).toBe('canned.execute.token');
        });
    });

    test('Ask again re-runs clarify with the typed instruction', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `claude-ask-${dayjs().valueOf()}@example.com`, async (page) => {
            const { contextId } = await seedInboxAndOpen(page, 'ask again me');
            const instructions: Array<string | undefined> = [];
            await page.route(ASSIST_GLOB, async (route) => {
                instructions.push((route.request().postDataJSON() as { instruction?: string }).instruction);
                await fulfillJson(route, cannedProposal(contextId));
            });

            await page.getByTestId('inboxItemClarifyClaudeButton').first().click();
            await expect(page.getByTestId('claudeReviewSummary')).toBeVisible();
            await page.getByTestId('claudeReviewAskAgainInput').fill('make it a calendar event');
            await page.getByTestId('claudeReviewAskAgain').click();
            await expect(page.getByTestId('claudeReviewSummary')).toBeVisible();

            // First call had no instruction; the Ask-again call carried the typed one.
            expect(instructions[0]).toBeUndefined();
            expect(instructions).toContain('make it a calendar event');
        });
    });

    test('Skip drops the side-effect so no apply request is sent', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `claude-skip-${dayjs().valueOf()}@example.com`, async (page) => {
            const { contextId } = await seedInboxAndOpen(page, 'skip me');
            await page.route(ASSIST_GLOB, (route) => fulfillJson(route, cannedProposal(contextId)));
            let applyCalled = false;
            await page.route(APPLY_GLOB, async (route) => {
                applyCalled = true;
                await fulfillJson(route, { applied: true, item: { id: 'x', status: 'nextAction', title: 't' } });
            });

            await page.getByTestId('inboxItemClarifyClaudeButton').first().click();
            await page.getByTestId('claudeReviewSkip').click();
            await expect(page.getByTestId('claudeReviewSkipped')).toBeVisible();
            // Apply is disabled once skipped — clicking it issues no request.
            await expect(page.getByTestId('claudeReviewApply')).toBeDisabled();
            expect(applyCalled).toBe(false);
        });
    });

    test('the daily spend cap (402) shows the limit copy and no apply control', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `claude-cap-${dayjs().valueOf()}@example.com`, async (page) => {
            await seedInboxAndOpen(page, 'capped item');
            await page.route(ASSIST_GLOB, (route) => fulfillJson(route, { error: 'cap', code: 'daily_spend_cap_reached' }, 402));

            await page.getByTestId('inboxItemClarifyClaudeButton').first().click();
            await expect(page.getByTestId('claudeReviewError')).toContainText('tomorrow');
            // A non-retryable error shows no "Try again" and no apply control.
            await expect(page.getByTestId('claudeReviewRetry')).toHaveCount(0);
            await expect(page.getByTestId('claudeReviewApply')).toHaveCount(0);
        });
    });

    test('an unavailable service (503 agent_unavailable) shows friendly copy with a retry', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `claude-unavail-${dayjs().valueOf()}@example.com`, async (page) => {
            await seedInboxAndOpen(page, 'unavailable item');
            // e.g. the API account is out of credits / overloaded — the user can only wait + retry.
            await page.route(ASSIST_GLOB, (route) => fulfillJson(route, { error: 'unavailable', code: 'agent_unavailable' }, 503));

            await page.getByTestId('inboxItemClarifyClaudeButton').first().click();
            await expect(page.getByTestId('claudeReviewError')).toContainText('temporarily unavailable');
            await expect(page.getByTestId('claudeReviewRetry')).toBeVisible();
        });
    });

    test('an expired token on apply (410) surfaces re-run copy with a retry', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `claude-expired-${dayjs().valueOf()}@example.com`, async (page) => {
            const { contextId } = await seedInboxAndOpen(page, 'expired token item');
            await page.route(ASSIST_GLOB, (route) => fulfillJson(route, cannedProposal(contextId)));
            await page.route(APPLY_GLOB, (route) => fulfillJson(route, { error: 'expired', code: 'execute_token_expired' }, 410));

            await page.getByTestId('inboxItemClarifyClaudeButton').first().click();
            await page.getByTestId('claudeReviewApply').click();
            await expect(page.getByTestId('claudeReviewError')).toContainText('expired');
            await expect(page.getByTestId('claudeReviewRetry')).toBeVisible();
        });
    });
});
