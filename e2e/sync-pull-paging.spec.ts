import { expect, test } from '@playwright/test';
import { withTwoLoggedInDevices } from './helpers/context';
import { API_URL } from './helpers/env';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

/**
 * A device catching up pulls the op log in pages (`limit` + `hasMore`) instead of one unbounded
 * response. The page size is shrunk to 5 here so a dozen ops span several pages; production pages
 * are PULL_PAGE_SIZE ops.
 */
const PAGE_SIZE = 5;
const ITEM_COUNT = 12;
/** Mirrors the e2e API's `SYNC_CURSOR_HOLDBACK_SECONDS`: the server default of 5s, which `playwright.config.ts` does not override. */
const HOLDBACK_MS = 5_000;

interface PullPageSeen {
    hasMore: boolean | undefined;
}

/** Longest run of consecutive pulls shaped [...hasMore: true, hasMore: false] — one paged catch-up. */
function longestPageChain(pages: PullPageSeen[]): number {
    const chains = pages.reduce<{ current: number; longest: number }>(
        (acc, seen) => {
            const current = acc.current + 1;
            if (seen.hasMore === true) {
                return { current, longest: acc.longest };
            }
            return { current: 0, longest: Math.max(acc.longest, current) };
        },
        { current: 0, longest: 0 },
    );
    return chains.longest;
}

test('a device back from offline pages through the op log and ends up with every change', async ({ browser }) => {
    await withTwoLoggedInDevices(browser, `pull-paging-${uniqueStamp()}@example.com`, async (writer, reader) => {
        await gtd.setPullPageSize(reader, PAGE_SIZE);
        const pagesSeen: PullPageSeen[] = [];
        reader.on('response', async (response) => {
            const url = new URL(response.url());
            // Pages asked for at the shrunk size only: a boot pull still in flight when the size was
            // shrunk answers with a default-size page.
            if (!response.url().startsWith(API_URL) || url.pathname !== '/sync/pull' || url.searchParams.get('limit') !== String(PAGE_SIZE) || !response.ok()) {
                return;
            }
            const body = (await response.json().catch(() => ({}))) as { hasMore?: boolean };
            pagesSeen.push({ hasMore: body.hasMore });
        });

        // Offline, the reader's live channel is closed, so the changes pile up for one catch-up.
        await reader.context().setOffline(true);
        const titles = Array.from({ length: ITEM_COUNT }, (_, index) => `Paged item ${index + 1}`);
        for (const title of titles) {
            await gtd.collect(writer, title);
        }
        await gtd.flush(writer);
        // Let the ops age past the server's 5s cursor holdback: a page reaching into that window
        // carries the whole window and ends paging, so only settled ops are split into pages.
        await writer.waitForTimeout(HOLDBACK_MS + 1_000);
        await reader.context().setOffline(false);

        await expect.poll(async () => (await gtd.listItems(reader)).map((item) => item.title), { timeout: 15_000 }).toEqual(expect.arrayContaining(titles));
        // The catch-up followed `hasMore` through an unbroken chain of at least 3 pages, ending on the last.
        await expect.poll(() => longestPageChain(pagesSeen)).toBeGreaterThanOrEqual(Math.ceil(ITEM_COUNT / PAGE_SIZE));
    });
});
