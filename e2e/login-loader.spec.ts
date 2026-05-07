import { expect, test } from '@playwright/test';

const CLIENT_URL = 'http://localhost:4173';

// Verifies the "Sign in with Google / GitHub" buttons show a loading state immediately on click
// and recover (re-enable + show error) if the underlying signIn.social() POST rejects.

test.describe('login page — loader on sign-in click', () => {
    test('clicking Google flips that button to "Redirecting…" with a spinner and disables both buttons', async ({ browser }) => {
        const ctx = await browser.newContext();
        try {
            const page = await ctx.newPage();
            // Stall the Better Auth social-sign-in POST so the loading state is observable.
            // Real path: POST {API}/auth/sign-in/social — slug-matches `**/auth/sign-in/social*`.
            await page.route('**/auth/sign-in/social*', async (route) => {
                await new Promise((r) => setTimeout(r, 1500));
                await route.continue();
            });

            await page.goto(`${CLIENT_URL}/login`);
            const googleBtn = page.getByRole('button', { name: 'Sign in with Google' });
            const githubBtn = page.getByRole('button', { name: 'Sign in with GitHub' });
            await expect(googleBtn).toBeEnabled();

            await googleBtn.click();

            // Clicked button shows the redirecting label; both buttons are disabled.
            const redirectingBtn = page.getByRole('button', { name: 'Redirecting…' });
            await expect(redirectingBtn).toBeVisible();
            await expect(redirectingBtn).toBeDisabled();
            await expect(githubBtn).toBeDisabled();
        } finally {
            await ctx.close();
        }
    });

    test('a failed signIn fetch resets the loading state and surfaces an error', async ({ browser }) => {
        const ctx = await browser.newContext();
        try {
            const page = await ctx.newPage();
            // Force the social-sign-in POST to fail at the network layer.
            await page.route('**/auth/sign-in/social*', async (route) => {
                await route.abort('failed');
            });

            await page.goto(`${CLIENT_URL}/login`);
            const googleBtn = page.getByRole('button', { name: 'Sign in with Google' });
            await googleBtn.click();

            // The error banner appears (role=alert) and the buttons re-enable.
            await expect(page.getByRole('alert')).toBeVisible({ timeout: 10_000 });
            await expect(page.getByRole('alert')).toContainText(/sign-in/i);
            await expect(googleBtn).toBeEnabled();
            await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeEnabled();
        } finally {
            await ctx.close();
        }
    });
});
