import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { resetServerForEmails, withOneLoggedInDevice, withTwoLoggedInDevices } from './helpers/context';
import { gtd } from './helpers/gtd';

const CLIENT_URL = 'http://localhost:4173';
const API_URL = 'http://localhost:4000';

// Settings → Connected devices: list every device syncing this account, rename, and remove one.
// Removal is the user-initiated analog of the stale-device reaper — the removed device's next
// sync must route through the same bootstrapRequired recovery flow the reaped-device spec covers.

/** Fetches GET /devices from inside the page (session cookie applies) — used to await server state. */
function fetchDeviceCount(page: Page): Promise<number> {
    return page.evaluate(async (apiUrl) => {
        const res = await fetch(`${apiUrl}/devices`, { credentials: 'include' });
        if (!res.ok) {
            throw new Error(`GET /devices ${res.status}`);
        }
        const { devices } = (await res.json()) as { devices: unknown[] };
        return devices.length;
    }, API_URL);
}

/** True when the server has a deviceSyncState row for this page's device. */
function isDeviceRegisteredOnServer(page: Page): Promise<boolean> {
    return page.evaluate(async (apiUrl) => {
        const harness = (window as unknown as { __gtd: { getDeviceId(): Promise<string> } }).__gtd;
        const deviceId = await harness.getDeviceId();
        const res = await fetch(`${apiUrl}/sync/device-status?deviceId=${encodeURIComponent(deviceId)}`, { credentials: 'include' });
        if (!res.ok) {
            throw new Error(`device-status ${res.status}`);
        }
        return ((await res.json()) as { registered: boolean }).registered;
    }, API_URL);
}

test.describe('Connected devices (settings)', () => {
    test('lists this device with label, rename works', async ({ browser }) => {
        const email = `devices-rename-${dayjs().valueOf()}@example.com`;
        await resetServerForEmails([email]);

        await withOneLoggedInDevice(browser, email, async (page) => {
            await page.goto(`${CLIENT_URL}/settings`);

            const row = page.getByTestId('deviceRow');
            await expect(row).toHaveCount(1);
            await expect(page.getByTestId('thisDeviceChip')).toBeVisible();
            // Playwright's Chromium UA contains "HeadlessChrome/…" — describeDevice labels it Chrome.
            await expect(row).toContainText('Chrome on');
            // The one and only device is fully synced — never flagged as blocking cleanup.
            await expect(page.getByTestId('holdingCleanupChip')).toHaveCount(0);
            // The current device must not offer Remove (removing yourself is just a forced resync).
            await expect(page.getByTestId('removeDeviceButton')).toHaveCount(0);
            await expect(page.getByTestId('opsLogSummary')).toContainText('Sync history:');

            await page.getByTestId('renameDeviceButton').click();
            const dialog = page.getByTestId('renameDeviceDialog');
            await expect(dialog).toBeVisible();
            await page.getByTestId('deviceNameInput').locator('input').fill('My main browser');
            await page.getByTestId('confirmRenameDeviceButton').click();
            await expect(dialog).toBeHidden();
            await expect(row).toContainText('My main browser');

            // The rename persisted server-side — still there after a reload.
            await page.reload();
            await expect(page.getByTestId('deviceRow')).toContainText('My main browser');
        });
    });

    test('surfaces load and action errors inline', async ({ browser }) => {
        const email = `devices-errors-${dayjs().valueOf()}@example.com`;
        await resetServerForEmails([email]);

        await withOneLoggedInDevice(browser, email, async (page) => {
            // Load failure: GET /devices → 500 shows the section-level load error.
            await page.route('**/devices', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) }));
            await page.goto(`${CLIENT_URL}/settings`);
            await expect(page.getByTestId('devicesLoadError')).toBeVisible();
            await page.unroute('**/devices');

            await page.reload();
            await expect(page.getByTestId('deviceRow')).toHaveCount(1);

            // Action failure: PATCH /devices/:id → 500 closes the dialog and shows the action error
            // (the dialog must not stay open hiding the message behind the modal).
            await page.route('**/devices/*', (route) =>
                route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'rename failed' }) }),
            );
            await page.getByTestId('renameDeviceButton').click();
            await page.getByTestId('deviceNameInput').locator('input').fill('Doomed name');
            await page.getByTestId('confirmRenameDeviceButton').click();
            await expect(page.getByTestId('renameDeviceDialog')).toBeHidden();
            await expect(page.getByTestId('devicesActionError')).toContainText('rename failed');
        });
    });

    test('removing a second device frees it server-side and it recovers via bootstrap', async ({ browser }) => {
        const email = `devices-remove-${dayjs().valueOf()}@example.com`;
        await resetServerForEmails([email]);

        await withTwoLoggedInDevices(browser, email, async (page1, page2) => {
            // Both devices produce + receive data so the removal has real sync state behind it.
            await gtd.collect(page1, 'Shared item');
            await gtd.flush(page1);
            await gtd.pull(page2);

            // Wait until BOTH devices' bootstrap registrations are visible server-side before
            // opening the settings list (device 2's bootstrap may still be in flight).
            await expect.poll(() => fetchDeviceCount(page1), { timeout: 15_000 }).toBe(2);
            await page1.goto(`${CLIENT_URL}/settings`);
            await expect(page1.getByTestId('deviceRow')).toHaveCount(2);

            // Exactly one row is the current device; the other one carries the Remove button.
            await expect(page1.getByTestId('thisDeviceChip')).toHaveCount(1);
            await expect(page1.getByTestId('removeDeviceButton')).toHaveCount(1);

            await page1.getByTestId('removeDeviceButton').click();
            const dialog = page1.getByTestId('removeDeviceDialog');
            await expect(dialog).toBeVisible();
            // The copy must state that removal is not a sign-out — a still-in-use device re-registers.
            await expect(dialog).toContainText('re-register on its next sync');
            await page1.getByTestId('confirmRemoveDeviceButton').click();
            await expect(dialog).toBeHidden({ timeout: 15_000 });

            // The list drops to one row and reports the removal.
            await expect(page1.getByTestId('deviceRow')).toHaveCount(1);
            await expect(page1.getByTestId('deviceRemovedSummary')).toBeVisible();
            await expect.poll(() => fetchDeviceCount(page1), { timeout: 10_000 }).toBe(1);

            // Device 2 was removed while "offline enough" (no queued ops). On its next visit it
            // must route through the same recovery as a reaped device: auto-bootstrap, then a
            // re-registered row and intact data — nothing silently skipped.
            expect(await isDeviceRegisteredOnServer(page2)).toBe(false);
            await page2.reload();
            await expect.poll(() => isDeviceRegisteredOnServer(page2), { timeout: 20_000 }).toBe(true);
            await expect(page2.getByTestId('syncRecoveryDialog')).toBeHidden({ timeout: 10_000 });
            await expect.poll(async () => (await gtd.listItems(page2)).some((i) => i.title === 'Shared item'), { timeout: 10_000 }).toBe(true);

            // And it syncs normally again afterwards.
            await gtd.collect(page2, 'Post-recovery item');
            await gtd.flush(page2);
            await gtd.pull(page1);
            await expect.poll(async () => (await gtd.listItems(page1)).some((i) => i.title === 'Post-recovery item'), { timeout: 10_000 }).toBe(true);
        });
    });
});
