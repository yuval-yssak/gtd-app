import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withTwoLoggedInDevices } from './helpers/context';
import { gtd } from './helpers/gtd';

/**
 * An installed PWA is frozen while backgrounded and returns with no cold boot, no offline→online
 * transition and a dead SSE socket — so before the resume trigger existed, the only way to see
 * fresh data on iOS was to force-quit the app and relaunch it.
 *
 * These specs drive the resume path the way the OS does: dispatch the foreground events and assert
 * the app re-syncs on its own, with no explicit gtd.pull().
 */

/** Simulates the OS foregrounding the app. Both events fire, as iOS does on a real resume. */
async function simulateAppResume(page: Page): Promise<void> {
    await page.evaluate(() => {
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('pageshow'));
    });
}

/** Polls the page's IDB for a title, without pulling — the app must sync itself. */
async function waitForTitleWithoutPulling(page: Page, title: string): Promise<void> {
    const found = await page.evaluate(async (wanted) => {
        type Harness = { listItems(): Promise<{ title: string }[]> };
        const harness = (window as unknown as { __gtd: Harness }).__gtd;
        // Date.now() is intentional — this closure runs in the browser, where dayjs is unavailable.
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
            const items = await harness.listItems();
            if (items.some((i) => i.title === wanted)) {
                return true;
            }
            await new Promise((r) => setTimeout(r, 200));
        }
        return false;
    }, title);

    if (!found) {
        throw new Error(`"${title}" never reached device IDB after resume (10s)`);
    }
}

test.describe('PWA resume sync', () => {
    test('a resumed app pulls a change made elsewhere without an explicit pull', async ({ browser }) => {
        const email = `resume-${dayjs().valueOf()}@example.com`;
        await withTwoLoggedInDevices(browser, email, async (page1, page2) => {
            // Device 2 is the "backgrounded phone": sever its live channel so it cannot learn about
            // the change through SSE, which is exactly the state iOS leaves a frozen PWA in.
            await page2.evaluate(() => {
                const harness = (window as unknown as { __gtd: { closeSse?: () => void } }).__gtd;
                harness.closeSse?.();
            });

            await gtd.collect(page1, 'Made while phone was asleep');
            await gtd.flush(page1);

            await simulateAppResume(page2);

            await waitForTitleWithoutPulling(page2, 'Made while phone was asleep');
        });
    });

    test('a resume while offline opens no channels — the online transition owns that', async ({ browser }) => {
        const email = `resume-offline-${dayjs().valueOf()}@example.com`;
        await withTwoLoggedInDevices(browser, email, async (_page1, page2) => {
            await page2.evaluate(() => {
                const harness = (window as unknown as { __gtd: { closeSse?: () => void } }).__gtd;
                harness.closeSse?.();
            });
            await page2.context().setOffline(true);

            await simulateAppResume(page2);

            // Reconnecting here would race the isOnline effect and churn dead sockets; the resume
            // handler must defer instead.
            expect(await page2.evaluate(() => (window as unknown as { __gtd: { sseChannelUserIds(): string[] } }).__gtd.sseChannelUserIds())).toEqual([]);
            await page2.context().setOffline(false);
        });
    });

    test('resume rebuilds the SSE channels a freeze tore down', async ({ browser }) => {
        const email = `resume-sse-${dayjs().valueOf()}@example.com`;
        await withTwoLoggedInDevices(browser, email, async (_page1, page2) => {
            await page2.evaluate(() => {
                const harness = (window as unknown as { __gtd: { closeSse?: () => void } }).__gtd;
                harness.closeSse?.();
            });
            await expect
                .poll(() => page2.evaluate(() => (window as unknown as { __gtd: { sseChannelUserIds(): string[] } }).__gtd.sseChannelUserIds()))
                .toEqual([]);

            await simulateAppResume(page2);

            // Reconnect is async (it awaits the deviceId read), so poll rather than assert once.
            await expect
                .poll(() => page2.evaluate(() => (window as unknown as { __gtd: { sseChannelUserIds(): string[] } }).__gtd.sseChannelUserIds().length), {
                    timeout: 10_000,
                })
                .toBeGreaterThan(0);
        });
    });
});
