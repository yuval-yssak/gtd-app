import { expect, type Page, test } from '@playwright/test';
import { withOneLoggedInDevice } from './helpers/context';
import { uniqueStamp } from './helpers/uniqueStamp';

// The two lazily loaded chunks. Vite names a chunk after its entry module, then a content hash.
const LAZY_CHUNK_URL = /\/assets\/(MarkdownNotesEditorView|CompletionCelebration)-[\w-]+\.js$/;

async function hasFetchedChunk(page: Page, chunkName: string) {
    return page.evaluate((name) => performance.getEntriesByType('resource').some((entry) => entry.name.includes(`/assets/${name}-`)), chunkName);
}

// Simulates a deploy while the tab stays open: the old hashed chunk URLs stop existing and the
// host's SPA fallback answers them with the HTML shell — exactly what production does.
async function simulateDeployRemovingLazyChunks(page: Page) {
    await page.route(LAZY_CHUNK_URL, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html></html>' }));
}

test.describe('Lazy chunks are warmed so a tab survives a deploy', () => {
    test('both lazy chunks load in the background once the app is idle', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `chunk-warm-${uniqueStamp()}@example.com`, async (page) => {
            await expect(page.getByTestId('inboxAddNoteButton')).toBeVisible();

            await expect.poll(() => hasFetchedChunk(page, 'MarkdownNotesEditorView'), { timeout: 10_000 }).toBe(true);
            await expect.poll(() => hasFetchedChunk(page, 'CompletionCelebration'), { timeout: 10_000 }).toBe(true);
        });
    });

    test('the notes editor still opens as CodeMirror after its chunk URL disappears', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `chunk-deploy-${uniqueStamp()}@example.com`, async (page) => {
            await expect(page.getByTestId('inboxAddNoteButton')).toBeVisible();
            await expect.poll(() => hasFetchedChunk(page, 'MarkdownNotesEditorView'), { timeout: 10_000 }).toBe(true);

            await simulateDeployRemovingLazyChunks(page);
            await page.getByTestId('inboxAddNoteButton').click();

            // Without the warm-up the import would hit the dead URL and degrade to the plain textarea.
            await expect(page.getByTestId('markdownNotesEditor')).toBeVisible();
            await expect(page.getByTestId('markdownNotesEditorFallback')).toHaveCount(0);
        });
    });
});
