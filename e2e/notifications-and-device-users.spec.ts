import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice, withTwoAccountsOnOneDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Dev-only endpoints exercised here:
//   GET  /dev/device-users?deviceId=<id> → server's deviceUsers join rows for the device
//   POST /dev/drop-push-subscription     → simulate a server-side {registered:false}
// Both are guarded in api-server/src/routes/devLogin.ts and only mounted when NODE_ENV !== 'production'.

const DEV_DEVICE_USERS_URL = 'http://localhost:4000/dev/device-users';
const DEV_DROP_PUSH_URL = 'http://localhost:4000/dev/drop-push-subscription';

interface ServerDeviceUserRow {
    deviceId: string;
    userId: string;
}

async function readServerDeviceUserRows(deviceId: string): Promise<ServerDeviceUserRow[]> {
    const res = await fetch(`${DEV_DEVICE_USERS_URL}?deviceId=${encodeURIComponent(deviceId)}`);
    if (!res.ok) {
        throw new Error(`GET /dev/device-users ${res.status}`);
    }
    const body = (await res.json()) as { rows: ServerDeviceUserRow[] };
    return body.rows;
}

async function dropServerPushSubscription(deviceId: string): Promise<void> {
    const res = await fetch(DEV_DROP_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId }),
    });
    if (!res.ok) {
        throw new Error(`POST /dev/drop-push-subscription ${res.status}`);
    }
}

// The auth-middleware deviceUsers upsert is fire-and-forget — poll briefly until the join row appears.
// Tests must NEVER race on this; without the wait the e2e flake rate is high.
async function waitForDeviceUserRow(deviceId: string, userId: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const rows = await readServerDeviceUserRows(deviceId);
        if (rows.some((r) => r.userId === userId)) {
            return;
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`deviceUsers row for (${deviceId}, ${userId}) never appeared`);
}

// Drives the full sign-out flow from the page context — the test would otherwise need to
// reach into Better Auth internals. signOutCurrent() handles the deviceUsers cleanup.
async function signOutCurrentInPage(page: Page): Promise<void> {
    await page.evaluate(async () => {
        // Run the sign-out path used by the production sign-out menu — it calls /devices/signout
        // before authClient.signOut, exactly the order the production code uses.
        const apiServer = 'http://localhost:4000';
        type IDBDatabase = { get(store: string, key: string): Promise<{ deviceId: string } | undefined> };
        const dbHandle = (window as unknown as { __gtd: { db: IDBDatabase } }).__gtd.db;
        // Post-v4 the device identity lives in `deviceMeta` (split from per-user `syncCursors`).
        const meta = await dbHandle.get('deviceMeta', 'local');
        const deviceId = meta?.deviceId;
        await fetch(`${apiServer}/devices/signout`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId }),
        });
    });
}

test.describe('deviceUsers join — single account', () => {
    test('signing in writes a (deviceId, userId) row server-side', async ({ browser }) => {
        const email = `device-users-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            const deviceId = await gtd.getDeviceId(page);
            const userId = await gtd.getActiveAccountId(page);
            expect(userId).toBeTruthy();

            // The dev-login flow does not itself trigger an authenticated request; loginAs() does
            // (waits for sync to settle which fires /sync/pull or /sync/bootstrap with X-Device-Id).
            await waitForDeviceUserRow(deviceId, userId as string);

            const rows = await readServerDeviceUserRows(deviceId);
            expect(rows).toEqual([{ deviceId, userId }]);
        });
    });

    test('signing out drops the row for the active account', async ({ browser }) => {
        const email = `signout-${dayjs().valueOf()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            const deviceId = await gtd.getDeviceId(page);
            const userId = (await gtd.getActiveAccountId(page)) as string;
            await waitForDeviceUserRow(deviceId, userId);

            await signOutCurrentInPage(page);

            // The /devices/signout endpoint deletes synchronously, so no poll is needed here.
            const rows = await readServerDeviceUserRows(deviceId);
            expect(rows.find((r) => r.userId === userId)).toBeUndefined();
        });
    });
});

test.describe('deviceUsers join — multi-account', () => {
    test('two accounts on one device produce two rows; signing one out leaves the other', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const emailA = `multi-a-${stamp}@example.com`;
        const emailB = `multi-b-${stamp}@example.com`;

        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            // Active account's row is populated by loginAs's sync-settled wait; the secondary
            // session lives in the multi-session cookie, so we activate it server-side and fire
            // an authenticated request under it to populate its deviceUsers row.
            const deviceId = await gtd.getDeviceId(page);
            await waitForDeviceUserRow(deviceId, active.userId);

            // Pivot to the secondary session via Better Auth's /auth/multi-session/set-active
            // endpoint. It accepts the raw (unsigned) token and rewrites the active session cookie.
            // Calling it from the page's fetch ensures the rewritten cookie ends up in the
            // BrowserContext jar that all subsequent fetches read from.
            await page.evaluate(
                async ({ rawToken }) => {
                    const res = await fetch('http://localhost:4000/auth/multi-session/set-active', {
                        method: 'POST',
                        credentials: 'include',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ sessionToken: rawToken }),
                    });
                    if (!res.ok) {
                        throw new Error(`set-active failed: ${res.status}`);
                    }
                },
                { rawToken: secondary.rawToken },
            );

            // Fire an authenticated request under the now-active secondary session. The auth
            // middleware reads X-Device-Id from the header and upserts the (deviceId, secondary)
            // row. /sync/pull is cheap and is already covered by the auth middleware.
            await page.evaluate(async (id) => {
                await fetch('http://localhost:4000/sync/pull', {
                    credentials: 'include',
                    headers: { 'X-Device-Id': id },
                });
            }, deviceId);

            await waitForDeviceUserRow(deviceId, secondary.userId);

            const rowsBefore = await readServerDeviceUserRows(deviceId);
            const userIdsBefore = rowsBefore.map((r) => r.userId).sort();
            expect(userIdsBefore).toEqual([active.userId, secondary.userId].sort());

            // /devices/signout reads the active session — secondary is currently active — so it
            // removes only the secondary's row.
            await page.evaluate(async (id) => {
                await fetch('http://localhost:4000/devices/signout', {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ deviceId: id }),
                });
            }, deviceId);

            const rowsAfter = await readServerDeviceUserRows(deviceId);
            expect(rowsAfter.map((r) => r.userId)).toEqual([active.userId]);
        });
    });
});

// The Settings → Notifications state machine. Drives the UI through its state transitions
// using context-level permission control where possible. Cases that Chromium can't simulate
// (Notification.permission === 'default' after a permission has been granted) are handled
// via page.addInitScript to inject a controllable Notification.permission accessor.

// Override Notification.permission via an init script so we can drive every state-machine
// branch deterministically. Chromium's BrowserContext.grantPermissions(['notifications']) does
// NOT flip Notification.permission to 'granted' in headless mode (it remains 'denied'), and
// there's no API to set it to 'default' after granting. The app reads Notification.permission
// directly in settings.tsx → refreshStatus, so a window-level override fully exercises the
// state machine end-to-end without depending on real browser permission state.
async function overrideNotificationPermission(ctx: import('@playwright/test').BrowserContext, permission: NotificationPermission): Promise<void> {
    await ctx.addInitScript((perm) => {
        class FakeNotification {
            static permission: NotificationPermission = perm;
            static requestPermission(): Promise<NotificationPermission> {
                return Promise.resolve(perm);
            }
        }
        (window as unknown as { Notification: unknown }).Notification = FakeNotification;
    }, permission);
}

async function loginAndOverridePermission(
    browser: import('@playwright/test').Browser,
    email: string,
    permission: NotificationPermission,
): Promise<{ ctx: import('@playwright/test').BrowserContext; page: Page }> {
    const ctx = await browser.newContext();
    await overrideNotificationPermission(ctx, permission);
    const { loginAs } = await import('./helpers/login');
    const page = await loginAs(ctx, email);
    return { ctx, page };
}

async function seedServerSidePushSubscription(page: Page, deviceId: string): Promise<void> {
    // Mirrors the body shape the client's pushApi.registerPushEndpoint sends. Bypasses the
    // real PushManager.subscribe call (which fails in headless Chromium without a push service).
    await page.evaluate(async (id) => {
        await fetch('http://localhost:4000/push/subscribe', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', 'X-Device-Id': id },
            body: JSON.stringify({
                deviceId: id,
                endpoint: `https://push.example/${id}`,
                keys: { p256dh: 'p', auth: 'a' },
            }),
        });
    }, deviceId);
}

test.describe('Settings → Notifications state machine', () => {
    test('shows "Notifications enabled" when permission and registration are both present', async ({ browser }) => {
        const email = `notif-on-${dayjs().valueOf()}@example.com`;
        const { ctx, page } = await loginAndOverridePermission(browser, email, 'granted');
        try {
            const deviceId = await gtd.getDeviceId(page);
            await seedServerSidePushSubscription(page, deviceId);

            const status = await gtd.getPushStatus(page);
            expect(status.registered).toBe(true);

            await page.goto('http://localhost:4173/settings');
            // Plain Typography line — match by exact text rather than role/aria.
            await expect(page.getByText('Notifications enabled.', { exact: true })).toBeVisible({ timeout: 10_000 });
        } finally {
            await ctx.close();
        }
    });

    test('flips to "Re-enable notifications" when the server-side subscription is dropped', async ({ browser }) => {
        const email = `notif-drop-${dayjs().valueOf()}@example.com`;
        const { ctx, page } = await loginAndOverridePermission(browser, email, 'granted');
        try {
            const deviceId = await gtd.getDeviceId(page);
            await seedServerSidePushSubscription(page, deviceId);

            // Drop server-side subscription — the next /push/status response says registered:false.
            await dropServerPushSubscription(deviceId);

            await page.goto('http://localhost:4173/settings');
            // Settings polls /push/status on mount via refreshStatus; the button then surfaces.
            await expect(page.getByRole('button', { name: 'Re-enable notifications' })).toBeVisible({ timeout: 10_000 });
        } finally {
            await ctx.close();
        }
    });

    test('shows "Enable notifications" CTA when permission has not been granted', async ({ browser }) => {
        const email = `notif-default-${dayjs().valueOf()}@example.com`;
        const { ctx, page } = await loginAndOverridePermission(browser, email, 'default');
        try {
            await page.goto('http://localhost:4173/settings');
            await expect(page.getByRole('button', { name: 'Enable notifications' })).toBeVisible({ timeout: 10_000 });
        } finally {
            await ctx.close();
        }
    });
});
