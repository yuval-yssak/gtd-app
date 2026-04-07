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

export async function fetchDevSessionCookie(email: string): Promise<DevLoginResponse> {
    const res = await fetch(DEV_LOGIN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
    });
    if (!res.ok) {
        throw new Error(`Dev login failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as DevLoginResponse;
}

// /auth/callback populates IndexedDB (upsertAccount + setActiveAccount) then redirects to /.
// Without this navigation, window.__gtd.* would throw "No active account" on every call.
async function openAuthenticatedPage(context: BrowserContext, cookie: DevLoginResponse['cookie']): Promise<Page> {
    await context.addCookies([cookie]);
    const page = await context.newPage();
    await page.goto(`${CLIENT_URL}/auth/callback`);
    // /auth/callback redirects to /, which /_authenticated/index immediately redirects to /inbox
    await page.waitForURL(`${CLIENT_URL}/inbox`);
    return page;
}

async function waitForHarness(page: Page): Promise<void> {
    // Wait until the dev tools harness is mounted — openAppDB() is async and __gtd is set
    // only after it resolves. Without this guard, evaluate() calls immediately after
    // loginAs() would fail with "window.__gtd is undefined".
    await page.waitForFunction(() => typeof (window as unknown as { __gtd?: unknown }).__gtd !== 'undefined');
}

async function waitForSyncSettled(page: Page): Promise<void> {
    // bootstrapFromServer sets lastSyncedTs = epoch BEFORE the network fetch completes.
    // A non-epoch lastSyncedTs confirms the network I/O finished and items are in IDB.
    //
    // Use evaluate() with an inline polling loop rather than waitForFunction() — the latter
    // resolves as soon as the predicate returns truthy, but a Promise is always truthy,
    // so waitForFunction() with an async predicate would return immediately without awaiting
    // the resolved value.
    await page.evaluate(async () => {
        type Harness = { syncState(): Promise<{ lastSyncedTs: string } | undefined> };
        const harness = (window as unknown as { __gtd: Harness }).__gtd;
        // Date.now() is intentional — this closure runs in the browser context where dayjs is unavailable.
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
            const s = await harness.syncState();
            if (s !== undefined && s !== null && s.lastSyncedTs !== '1970-01-01T00:00:00.000Z') {
                return;
            }
            await new Promise((r) => setTimeout(r, 200));
        }
    });
}

/**
 * Log a browser context in as the given email address using the dev-only login bypass.
 * Returns the page, already on the app's main route with IDB initialized and sync settled.
 */
export async function loginAs(context: BrowserContext, email: string): Promise<Page> {
    const { cookie } = await fetchDevSessionCookie(email);
    const page = await openAuthenticatedPage(context, cookie);
    await waitForHarness(page);
    await waitForSyncSettled(page);
    return page;
}
