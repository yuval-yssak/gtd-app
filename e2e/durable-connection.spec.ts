import { expect, type Page, type Route, test } from '@playwright/test';
import { withOneLoggedInDevice } from './helpers/context';
import { API_URL, CLIENT_URL } from './helpers/env';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

/**
 * A device that has synced before, opened on a spotty connection. Every step of connecting to the
 * server must keep retrying until it succeeds — a failed step used to be abandoned for the page's
 * whole life. The sharpest case: the browser gives up on a live channel for good when its first
 * connect gets an error page (a Cloudflare 5xx) instead of a stream, so live updates never arrived.
 */

/** Generous for the repair backoff (5s, then 15s) on a loaded machine, far below "never". */
const RECOVERY_BUDGET_MS = 30_000;

/** Every API request fails at once, and the live channel gets an error page instead of a stream. */
async function spottyNetwork(page: Page) {
    const dropRequest = (route: Route) => route.abort('connectionreset');
    const errorPageForChannel = (route: Route) => route.fulfill({ status: 503, contentType: 'text/html', body: '<h1>503</h1>' });
    await page.route(`${API_URL}/**`, dropRequest);
    // Registered last, so it wins for the live channel.
    await page.route(`${API_URL}/sync/events**`, errorPageForChannel);
    return {
        recover: async () => {
            await page.unroute(`${API_URL}/sync/events**`, errorPageForChannel);
            await page.unroute(`${API_URL}/**`, dropRequest);
        },
    };
}

test.describe('durable connection on a spotty start', () => {
    test('a live channel the browser gave up on at load is reopened once the network recovers', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `durable-sse-${uniqueStamp()}@example.com`, async (page) => {
            const userId = await gtd.getActiveAccountId(page);
            if (!userId) throw new Error('expected an active account');
            await gtd.flush(page);

            const network = await spottyNetwork(page);
            const channelRefused = page.waitForEvent('requestfinished', (request) => request.url().includes('/sync/events'));
            await page.goto(`${CLIENT_URL}/inbox`);
            await channelRefused;

            await network.recover();
            await expect.poll(() => gtd.sseConnectedUserIds(page), { timeout: RECOVERY_BUDGET_MS }).toContain(userId);
        });
    });
});
