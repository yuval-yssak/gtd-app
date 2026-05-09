import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Each list page renders a per-row copy-id button alongside the existing edit/action buttons.
// We exercise four chrome shapes:
//   - inbox row (large secondaryAction stack)
//   - next-actions row (small secondaryAction stack inside a routed page)
//   - /done row (archived view — rows are wrapped in a <Link>, so the secondaryAction is rendered
//                outside the link)
//   - /search row (Link-wrapped row, but inside a search results list with its own chrome)
// The dialog test (item-editor-copy-id.spec.ts) already covers the click-to-clipboard contract
// of the underlying CopyIdButton component, so these tests focus on row wiring.

test.describe('Copy item ID — list pages', () => {
    test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

    test('inbox row exposes the copy button and copies the _id', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `copyid-list-inbox-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Inbox copy-id row target');

            await page.goto('/inbox');
            await page.waitForSelector('text=Inbox copy-id row target');

            // Strict-mode-safe even when the list grows: scope to one button.
            await page.getByTestId('inboxItemCopyIdButton').first().click();

            const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
            expect(clipboardText).toBe(inbox._id);
        });
    });

    test('next-actions row exposes the copy button and copies the _id', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `copyid-list-next-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'NA copy-id row target');
            await gtd.clarifyToNextAction(page, inbox);

            await page.goto('/next-actions');
            await page.waitForSelector('text=NA copy-id row target');

            await page.getByTestId('nextActionItemCopyIdButton').first().click();

            const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
            expect(clipboardText).toBe(inbox._id);
        });
    });

    test('done row (archived view) exposes the copy button and copies the _id', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `copyid-list-done-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Done copy-id row target');
            // Archived view requires status === 'done'; the inbox quick-done path is the simplest route.
            await gtd.clarifyToDone(page, inbox);

            await page.goto('/done');
            await page.waitForSelector('text=Done copy-id row target');

            await page.getByTestId('archivedItemCopyIdButton').first().click();

            const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
            expect(clipboardText).toBe(inbox._id);
        });
    });

    test('search row exposes the copy button and copies the _id', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `copyid-list-search-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Search copy-id row target');

            // Hit /search with a query that matches just this item — the search results list
            // (Link-wrapped rows) is what we want to exercise here.
            await page.goto('/search?q=Search%20copy-id%20row%20target');
            await page.waitForSelector('text=Search copy-id row target');

            await page.getByTestId('searchResultCopyIdButton').first().click();

            const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
            expect(clipboardText).toBe(inbox._id);
        });
    });
});
