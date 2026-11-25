import { expect, type Page, test } from '@playwright/test';
import { withOneLoggedInDevice } from './helpers/context';
import { CLIENT_URL } from './helpers/env';
import { evaluateWithHarness } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

// Safari (the installed iOS PWA above all) drops the IndexedDB connection while the app sits in
// the background; the page then read through the dead connection and showed "Something went wrong".
// This reproduces the synchronous mode (a closed connection throws InvalidStateError); WebKit's
// asynchronous mode — a request failing with UnknownError inside a live transaction — is pinned
// at unit level in client/src/tests/selfHealingDB.test.ts.
async function loseDatabaseConnection(page: Page) {
    await evaluateWithHarness(page, () => (window as unknown as { __gtd: { simulateConnectionLoss(): void } }).__gtd.simulateConnectionLoss());
}

async function captureToInbox(page: Page, title: string) {
    const capture = page.getByPlaceholder("What's on your mind?");
    await capture.fill(title);
    await capture.press('Enter');
}

test.describe('the app survives Safari dropping its IndexedDB connection', () => {
    test('a capture made after the connection is lost is saved and survives a reload', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `idb-loss-capture-${uniqueStamp()}@example.com`, async (page) => {
            await page.goto(`${CLIENT_URL}/inbox`);
            await captureToInbox(page, 'Captured before the loss');
            await expect(page.getByText('Captured before the loss')).toBeVisible();

            await loseDatabaseConnection(page);
            await captureToInbox(page, 'Captured after the loss');

            await expect(page.getByText('Captured after the loss')).toBeVisible();
            await expect(page.getByTestId('pageErrorBoundary')).toHaveCount(0);
            await page.reload();
            await expect(page.getByText('Captured after the loss')).toBeVisible();
            await expect(page.getByText('Captured before the loss')).toBeVisible();
        });
    });

    test('moving between pages after the connection is lost shows the lists, not the error page', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `idb-loss-nav-${uniqueStamp()}@example.com`, async (page) => {
            await page.goto(`${CLIENT_URL}/inbox`);
            await captureToInbox(page, 'Still listed');
            await expect(page.getByText('Still listed')).toBeVisible();

            await loseDatabaseConnection(page);
            await page.getByRole('link', { name: 'Next Actions' }).click();
            await page.getByRole('link', { name: 'Inbox' }).click();

            await expect(page.getByText('Still listed')).toBeVisible();
            await expect(page.getByTestId('pageErrorBoundary')).toHaveCount(0);
            await expect(page.getByTestId('inlineErrorBoundary')).toHaveCount(0);
        });
    });
});
