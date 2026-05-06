import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { resetServerForEmails, withOneLoggedInDevice } from './helpers/context';

const CLIENT_URL = 'http://localhost:4173';

// Cover the user-visible flow end-to-end: navigate to settings, mint a token, observe the
// one-shot reveal, copy plaintext, revoke from the list, and verify the row stays visible
// in dimmed/revoked form. The /v1 round-trip with the minted token is covered separately
// by `public-api.spec.ts` (issue #19 step 2) — keeping that out of this spec keeps the
// settings-UI assertions tight and the spec fast.

test.describe('Personal API tokens (settings)', () => {
    test('mint, reveal, revoke', async ({ browser }) => {
        const email = `tokens-${dayjs().valueOf()}@example.com`;
        await resetServerForEmails([email]);

        await withOneLoggedInDevice(browser, email, async (page) => {
            await page.goto(`${CLIENT_URL}/settings`);

            // Empty state shows the "Create token" CTA on first visit.
            await expect(page.getByTestId('tokensEmptyState')).toBeVisible();

            await page.getByTestId('createTokenButton').click();
            await page.getByTestId('tokenLabelInput').locator('input').fill('Local MCP');
            await page.getByTestId('confirmCreateTokenButton').click();

            // Reveal dialog shows the plaintext exactly once. The plaintext starts with `gtd_` per
            // `apiTokens.ts:6`; we only assert the prefix to avoid coupling to the random tail length.
            const reveal = page.getByTestId('tokenRevealDialog');
            await expect(reveal).toBeVisible();
            const plaintext = (await page.getByTestId('tokenPlaintext').textContent()) ?? '';
            expect(plaintext.startsWith('gtd_')).toBe(true);
            expect(plaintext.length).toBeGreaterThan(20);

            await page.getByTestId('dismissRevealButton').click();
            await expect(reveal).toBeHidden();

            // List now shows the row with label + "Never used".
            const row = page.getByTestId('tokenRow');
            await expect(row).toHaveCount(1);
            await expect(row).toContainText('Local MCP');
            await expect(row).toContainText('Never used');

            // Revoke flow.
            await page.getByTestId('revokeTokenButton').click();
            await page.getByTestId('confirmRevokeTokenButton').click();

            // After revoke, the row stays visible (so users can see what they revoked) but the
            // Revoke button is gone and the secondary text shows the revoke date.
            await expect(row).toContainText('Local MCP');
            await expect(row).toContainText('Revoked');
            await expect(page.getByTestId('revokeTokenButton')).toHaveCount(0);
        });
    });

    test('label is required; create button surfaces the validation error inline', async ({ browser }) => {
        const email = `label-required-${dayjs().valueOf()}@example.com`;
        await resetServerForEmails([email]);

        await withOneLoggedInDevice(browser, email, async (page) => {
            await page.goto(`${CLIENT_URL}/settings`);
            await page.getByTestId('createTokenButton').click();
            // Submit with the label blank — must surface inline validation, not call the server.
            await page.getByTestId('confirmCreateTokenButton').click();
            await expect(page.getByTestId('createTokenDialog')).toBeVisible();
            // MUI helperText renders inside the TextField wrapper; use the dialog as the scope.
            await expect(page.getByTestId('createTokenDialog')).toContainText('Label is required');
            await expect(page.getByTestId('tokenRevealDialog')).toHaveCount(0);
        });
    });

    test('copy-to-clipboard failure surfaces an inline error and keeps the reveal dialog open', async ({ browser }) => {
        const email = `copy-fail-${dayjs().valueOf()}@example.com`;
        await resetServerForEmails([email]);

        await withOneLoggedInDevice(browser, email, async (page) => {
            await page.goto(`${CLIENT_URL}/settings`);

            // Force navigator.clipboard.writeText to reject so the failure path runs.
            // Using addInitScript would be too early (runs before SPA mount); evaluate after navigation
            // is more direct here.
            await page.evaluate(() => {
                Object.defineProperty(navigator, 'clipboard', {
                    configurable: true,
                    value: { writeText: () => Promise.reject(new Error('Permission denied')) },
                });
            });

            await page.getByTestId('createTokenButton').click();
            await page.getByTestId('tokenLabelInput').locator('input').fill('Copy fail');
            await page.getByTestId('confirmCreateTokenButton').click();

            const reveal = page.getByTestId('tokenRevealDialog');
            await expect(reveal).toBeVisible();

            await page.getByTestId('copyTokenButton').click();
            await expect(page.getByTestId('copyTokenError')).toContainText('Permission denied');
            // Reveal dialog must remain open so the user can still copy the token manually.
            await expect(reveal).toBeVisible();
        });
    });

    test('reveal dialog cannot be dismissed by Escape or backdrop click', async ({ browser }) => {
        const email = `reveal-pin-${dayjs().valueOf()}@example.com`;
        await resetServerForEmails([email]);

        await withOneLoggedInDevice(browser, email, async (page) => {
            await page.goto(`${CLIENT_URL}/settings`);
            await page.getByTestId('createTokenButton').click();
            await page.getByTestId('tokenLabelInput').locator('input').fill('Pin test');
            await page.getByTestId('confirmCreateTokenButton').click();

            const reveal = page.getByTestId('tokenRevealDialog');
            await expect(reveal).toBeVisible();

            // Escape should NOT dismiss — disableEscapeKeyDown is set on the reveal dialog.
            await page.keyboard.press('Escape');
            await expect(reveal).toBeVisible();

            // Backdrop click should also NOT dismiss — the onClose handler ignores 'backdropClick'.
            // MUI's backdrop sits behind the modal and the safest cross-browser way to click it is
            // through the page's body at coordinate (1, 1), which lands outside the dialog content.
            await page.mouse.click(1, 1);
            await expect(reveal).toBeVisible();

            await page.getByTestId('dismissRevealButton').click();
            await expect(reveal).toBeHidden();
        });
    });
});
