import type { BrowserContext, Page } from '@playwright/test';

const DEV_LOGIN_URL = 'http://localhost:4000/dev/login';
const CLIENT_URL = 'http://localhost:4173';

interface DevLoginResponse {
    ok: boolean;
    userId: string;
    email: string;
    cookie: {
        name: string;
        value: string;
        domain: string;
        path: string;
        httpOnly: boolean;
        secure: boolean;
        sameSite: 'Strict' | 'Lax' | 'None';
        expires: number; // Unix seconds
    };
}

/**
 * Log a browser context in as the given email address using the dev-only login bypass.
 *
 * Steps:
 *  1. POST /dev/login → get a signed Better Auth session cookie
 *  2. Inject the cookie into the context so all its pages are authenticated
 *  3. Navigate to /auth/callback — the existing route calls authClient.getSession(),
 *     writes the account into IndexedDB, then redirects to /. This populates the IDB
 *     state that the rest of the app (syncAndRefresh, window.__gtd.*) depends on.
 *  4. Wait for __gtd to be available before returning, so callers can use it immediately.
 *
 * Returns the page, already on the app's main route.
 */
export async function loginAs(context: BrowserContext, email: string): Promise<Page> {
    const res = await fetch(DEV_LOGIN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
    });

    if (!res.ok) {
        throw new Error(`Dev login failed: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as DevLoginResponse;
    await context.addCookies([data.cookie]);

    const page = await context.newPage();

    // /auth/callback populates IndexedDB (upsertAccount + setActiveAccount) then redirects to /.
    // Without this step, window.__gtd.* would throw "No active account" on every call.
    await page.goto(`${CLIENT_URL}/auth/callback`);
    await page.waitForURL(`${CLIENT_URL}/`);

    // Wait until the dev tools harness is mounted — openAppDB() is async and __gtd is set
    // only after it resolves. Without this guard, evaluate() calls immediately after
    // loginAs() would fail with "window.__gtd is undefined".
    await page.waitForFunction(() => typeof (window as unknown as { __gtd?: unknown }).__gtd !== 'undefined');

    // Wait until bootstrapFromServer (or pullFromServer) has written a real server timestamp.
    // bootstrapFromServer calls getOrCreateDeviceId() which sets lastSyncedTs = epoch (1970)
    // BEFORE the network fetch completes. Checking for non-null alone resolves too early.
    // A non-epoch lastSyncedTs confirms the network I/O finished and items are in IDB.
    await page.waitForFunction(
        () =>
            (
                window as unknown as {
                    __gtd: { syncState(): Promise<{ lastSyncedTs: string } | undefined> };
                }
            ).__gtd
                .syncState()
                .then((s) => s !== undefined && s !== null && s.lastSyncedTs !== '1970-01-01T00:00:00.000Z'),
        undefined,
        { timeout: 15_000, polling: 200 },
    );

    return page;
}
