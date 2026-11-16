import { expect, test } from '@playwright/test';
import { withOneLoggedInDevice } from './helpers/context';
import { CLIENT_URL } from './helpers/env';
import { uniqueStamp } from './helpers/uniqueStamp';

/**
 * Settings → Notifications on a device whose service worker never becomes ready (its install failed,
 * e.g. a precache 404 after a deploy). Registration waits on `navigator.serviceWorker.ready`, which
 * then never resolves: the button used to stay on "Requesting…" for the page's whole life.
 */

/** Beyond the app's SERVICE_WORKER_READY_DEADLINE_MS (10s), with room for a loaded machine. */
const GIVE_UP_BUDGET_MS = 20_000;

test.describe('Settings notifications', () => {
    test('the enable button recovers when the service worker never becomes ready', async ({ browser }) => {
        await withOneLoggedInDevice(
            browser,
            `settings-push-${uniqueStamp()}@example.com`,
            async (page) => {
                // Headless Chromium reports notifications as denied whatever the granted permission;
                // stand in for a browser where the user already allowed them.
                await page.addInitScript(() => {
                    Object.defineProperty(Notification, 'permission', { get: () => 'granted', configurable: true });
                });
                await page.goto(`${CLIENT_URL}/settings`);
                const button = page.getByTestId('enableNotificationsButton');
                // Permission is granted but this device has no subscription row yet.
                await expect(button).toHaveText('Re-enable notifications');

                await button.click();
                await expect(button).toHaveText('Requesting…');

                await expect(button).toHaveText('Re-enable notifications', { timeout: GIVE_UP_BUDGET_MS });
                await expect(button).toBeEnabled();
            },
            // A blocked service worker never registers, so `ready` never resolves — the failed-install case.
            { serviceWorkers: 'block' },
        );
    });
});
