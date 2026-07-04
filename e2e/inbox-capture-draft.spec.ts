import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import type { StoredDraft } from '../client/src/types/MyDB';
import { withOneLoggedInDevice } from './helpers/context';

const CLIENT_URL = 'http://localhost:4173';
const NOTES_PLACEHOLDER = 'Supports **bold**, _italic_, `code`, lists, etc.';

// Reads the drafts store through the dev-tools harness so the specs can wait for the debounced
// IDB write deterministically instead of sleeping past the debounce interval.
function readDrafts(page: Page): Promise<StoredDraft[]> {
    return page.evaluate(() => (window as unknown as { __gtd: { db: { getAll(store: 'drafts'): Promise<StoredDraft[]> } } }).__gtd.db.getAll('drafts'));
}

test.describe('inbox capture draft persistence', () => {
    test('half-typed title + notes survive a page reload', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `capture-draft-${dayjs().valueOf()}@example.com`, async (page) => {
            await page.goto(`${CLIENT_URL}/inbox`);
            await page.getByPlaceholder("What's on your mind?").fill('Half-typed thought');
            await page.getByTestId('inboxAddNoteButton').click();
            await page.getByPlaceholder(NOTES_PLACEHOLDER).fill('with a **markdown** note');

            await expect.poll(async () => (await readDrafts(page)).map((d) => d.title)).toEqual(['Half-typed thought']);

            await page.reload();

            await expect(page.getByPlaceholder("What's on your mind?")).toHaveValue('Half-typed thought');
            // The notes panel re-opens automatically because the draft carried notes.
            await expect(page.getByPlaceholder(NOTES_PLACEHOLDER)).toHaveValue('with a **markdown** note');
        });
    });

    test('immediate SPA navigation flushes the draft before the debounce settles', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `capture-draft-nav-${dayjs().valueOf()}@example.com`, async (page) => {
            await page.goto(`${CLIENT_URL}/inbox`);
            await page.getByPlaceholder("What's on your mind?").fill('Typed then bolted');
            // Navigate away right away — the unmount flush must persist the text without waiting
            // for the 300ms debounce tick.
            await page.getByRole('link', { name: 'Next Actions' }).click();
            await page.getByRole('link', { name: 'Inbox' }).click();

            await expect(page.getByPlaceholder("What's on your mind?")).toHaveValue('Typed then bolted');
        });
    });

    test('capturing the item clears the draft — a reload shows an empty capture field', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `capture-draft-clear-${dayjs().valueOf()}@example.com`, async (page) => {
            await page.goto(`${CLIENT_URL}/inbox`);
            const capture = page.getByPlaceholder("What's on your mind?");
            await capture.fill('Commit me');
            await expect.poll(async () => (await readDrafts(page)).length).toBe(1);

            await capture.press('Enter');
            await expect(page.getByText('Commit me')).toBeVisible();
            await expect.poll(async () => (await readDrafts(page)).length).toBe(0);

            await page.reload();
            await expect(page.getByPlaceholder("What's on your mind?")).toHaveValue('');
        });
    });
});
