import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { closeContextQuietly, withOneLoggedInDevice, withTwoAccountsOnOneDevice } from './helpers/context';
import { API_URL, CLIENT_URL } from './helpers/env';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

// Dev-only endpoints exercised here:
//   GET  /dev/device-users?deviceId=<id> → server's deviceUsers join rows for the device
//   POST /dev/drop-push-subscription     → simulate a server-side {registered:false}
// Both are guarded in api-server/src/routes/devLogin.ts and only mounted when NODE_ENV !== 'production'.

const DEV_DEVICE_USERS_URL = `${API_URL}/dev/device-users`;
const DEV_DROP_PUSH_URL = `${API_URL}/dev/drop-push-subscription`;

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

// Symmetric to waitForDeviceUserRow: /devices/signout removes the row asynchronously, so under
// full-suite load the removal — and the read that observes it — can lag well past a second.
// Poll until the row is gone before asserting. Budget is generous (15s) because this runs under
// the stop-hook's full-parallel-suite saturation, where the DELETE round-trip + read can queue
// behind a busy local Mongo; 5s proved too tight there.
async function waitForDeviceUserRowGone(deviceId: string, userId: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        const rows = await readServerDeviceUserRows(deviceId);
        if (!rows.some((r) => r.userId === userId)) {
            return;
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`deviceUsers row for (${deviceId}, ${userId}) never disappeared`);
}

// Drives the full sign-out flow from the page context — the test would otherwise need to
// reach into Better Auth internals. signOutCurrent() handles the deviceUsers cleanup.
async function signOutCurrentInPage(page: Page): Promise<void> {
    // The callback runs in the browser, so the API URL travels in as an argument.
    await page.evaluate(async (apiServer) => {
        // Run the sign-out path used by the production sign-out menu — it calls /devices/signout
        // before authClient.signOut, exactly the order the production code uses.
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
    }, API_URL);
}

test.describe('deviceUsers join — single account', () => {
    test('signing in writes a (deviceId, userId) row server-side', async ({ browser }) => {
        const email = `device-users-${uniqueStamp()}@example.com`;
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
        const email = `signout-${uniqueStamp()}@example.com`;
        await withOneLoggedInDevice(browser, email, async (page) => {
            const deviceId = await gtd.getDeviceId(page);
            const userId = (await gtd.getActiveAccountId(page)) as string;
            await waitForDeviceUserRow(deviceId, userId);

            // Pinned on its own first: the convergence poll below re-runs the endpoint from Node, so
            // without this a sign-out path that stopped calling /devices/signout would still pass.
            const pageSignout = page.waitForResponse((res) => res.url().endsWith('/devices/signout') && res.request().method() === 'POST');
            await signOutCurrentInPage(page);
            expect((await pageSignout).ok(), 'the sign-out path must call /devices/signout itself').toBe(true);

            // The delete is synchronous, but the app is still online: any authenticated request it
            // sent around the sign-out fires the auth middleware's fire-and-forget deviceUsers upsert,
            // which can land just after the delete and re-insert the row. Offline, the app sends
            // nothing new — so re-running the real sign-out (Node-side, same cookies) converges once
            // the last straggler has landed, while a sign-out that removes nothing still fails here.
            await page.context().setOffline(true);
            await expect
                .poll(async () => {
                    const res = await page.context().request.post(`${API_URL}/devices/signout`, { data: { deviceId } });
                    if (!res.ok()) {
                        throw new Error(`re-run sign-out failed: ${res.status()}`);
                    }
                    const rows = await readServerDeviceUserRows(deviceId);
                    return rows.find((r) => r.userId === userId);
                })
                .toBeUndefined();
        });
    });
});

test.describe('deviceUsers join — multi-account', () => {
    test('two accounts on one device produce two rows; signing one out leaves the other', async ({ browser }) => {
        const stamp = uniqueStamp();
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
            //
            // The pivot holds the app's session gate until the sign-out below: the page's own sync
            // pass pivots the cookie too, and one restoring the primary in between would make the
            // sign-out remove the PRIMARY's row. (The gate's own timeout frees it if the test dies.)
            // That timeout would also quietly reopen the race mid-hold, so it fails the test here.
            const gateTimeouts: string[] = [];
            page.on('console', (message) => {
                if (message.text().includes('session gate task exceeded')) gateTimeouts.push(message.text());
            });
            await page.evaluate(
                async ({ rawToken, apiUrl }) => {
                    type Harness = { withSessionGate(task: () => Promise<void>): Promise<void> };
                    const pageWindow = window as unknown as { __gtd: Harness; __releaseSpecSessionGate?: () => void };
                    await new Promise<void>((acquired) => {
                        void pageWindow.__gtd.withSessionGate(
                            () =>
                                new Promise<void>((release) => {
                                    pageWindow.__releaseSpecSessionGate = release;
                                    acquired();
                                }),
                        );
                    });
                    const res = await fetch(`${apiUrl}/auth/multi-session/set-active`, {
                        method: 'POST',
                        credentials: 'include',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ sessionToken: rawToken }),
                    });
                    if (!res.ok) {
                        throw new Error(`set-active failed: ${res.status}`);
                    }
                },
                { rawToken: secondary.rawToken, apiUrl: API_URL },
            );

            // Fire an authenticated request under the now-active secondary session. The auth
            // middleware reads X-Device-Id from the header and upserts the (deviceId, secondary)
            // row. /sync/pull is cheap and is already covered by the auth middleware.
            await page.evaluate(
                async ({ id, apiUrl }) => {
                    await fetch(`${apiUrl}/sync/pull`, {
                        credentials: 'include',
                        headers: { 'X-Device-Id': id },
                    });
                },
                { id: deviceId, apiUrl: API_URL },
            );

            await waitForDeviceUserRow(deviceId, secondary.userId);

            const rowsBefore = await readServerDeviceUserRows(deviceId);
            const userIdsBefore = rowsBefore.map((r) => r.userId).sort();
            expect(userIdsBefore).toEqual([active.userId, secondary.userId].sort());

            // /devices/signout reads the active session — secondary is currently active — so it
            // removes only the secondary's row.
            await page.evaluate(
                async ({ id, apiUrl }) => {
                    await fetch(`${apiUrl}/devices/signout`, {
                        method: 'POST',
                        credentials: 'include',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ deviceId: id }),
                    });
                    (window as unknown as { __releaseSpecSessionGate?: () => void }).__releaseSpecSessionGate?.();
                },
                { id: deviceId, apiUrl: API_URL },
            );
            expect(gateTimeouts, 'the session gate timed out mid-hold, so a sync pass could pivot the cookie').toEqual([]);

            // Take the page offline so no app-originated authenticated request (SSE-triggered sync,
            // push re-registration) carrying X-Device-Id under the still-active secondary cookie can
            // fire the auth middleware's fire-and-forget deviceUsers upsert AFTER signout and
            // re-insert the row we just removed. Our row polling below uses Node fetch (not the page),
            // so it's unaffected by the page's offline state. This race only surfaced under full-suite
            // load, where the straggler upsert landed seconds after the immediate read.
            await page.context().setOffline(true);

            // Removal is async — wait for the secondary's row to disappear before asserting the
            // surviving set, otherwise the read can race the signout under full-suite load.
            await waitForDeviceUserRowGone(deviceId, secondary.userId);
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
        // Mirrors the `Notification` global's class shape so app code reading `Notification.permission`
        // or calling `Notification.requestPermission()` works against the fake.
        // biome-ignore lint/complexity/noStaticOnlyClass: deliberately mirrors the Notification global API
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
    await page.evaluate(
        async ({ id, apiUrl }) => {
            await fetch(`${apiUrl}/push/subscribe`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json', 'X-Device-Id': id },
                body: JSON.stringify({
                    deviceId: id,
                    endpoint: `https://push.example/${id}`,
                    keys: { p256dh: 'p', auth: 'a' },
                }),
            });
        },
        { id: deviceId, apiUrl: API_URL },
    );
}

test.describe('Settings → Notifications state machine', () => {
    test('shows "Notifications enabled" when permission and registration are both present', async ({ browser }) => {
        const email = `notif-on-${uniqueStamp()}@example.com`;
        const { ctx, page } = await loginAndOverridePermission(browser, email, 'granted');
        try {
            const deviceId = await gtd.getDeviceId(page);
            await seedServerSidePushSubscription(page, deviceId);

            const status = await gtd.getPushStatus(page);
            expect(status.registered).toBe(true);

            await page.goto(`${CLIENT_URL}/settings`);
            // Plain Typography line — match by exact text rather than role/aria.
            await expect(page.getByText('Notifications enabled.', { exact: true })).toBeVisible({ timeout: 10_000 });
        } finally {
            await closeContextQuietly(ctx);
        }
    });

    test('flips to "Re-enable notifications" when the server-side subscription is dropped', async ({ browser }) => {
        const email = `notif-drop-${uniqueStamp()}@example.com`;
        const { ctx, page } = await loginAndOverridePermission(browser, email, 'granted');
        try {
            const deviceId = await gtd.getDeviceId(page);
            await seedServerSidePushSubscription(page, deviceId);

            // Drop server-side subscription — the next /push/status response says registered:false.
            await dropServerPushSubscription(deviceId);

            await page.goto(`${CLIENT_URL}/settings`);
            // Settings polls /push/status on mount via refreshStatus; the button then surfaces.
            await expect(page.getByRole('button', { name: 'Re-enable notifications' })).toBeVisible({ timeout: 10_000 });
        } finally {
            await closeContextQuietly(ctx);
        }
    });

    test('shows "Enable notifications" CTA when permission has not been granted', async ({ browser }) => {
        const email = `notif-default-${uniqueStamp()}@example.com`;
        const { ctx, page } = await loginAndOverridePermission(browser, email, 'default');
        try {
            await page.goto(`${CLIENT_URL}/settings`);
            await expect(page.getByRole('button', { name: 'Enable notifications' })).toBeVisible({ timeout: 10_000 });
        } finally {
            await closeContextQuietly(ctx);
        }
    });
});
