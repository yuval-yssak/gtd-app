import type { Browser, BrowserContext, Page } from '@playwright/test';
import { fetchDevSessionCookie, loginAs, pinEditorModeToDialog } from './login';

const DEV_MULTI_LOGIN_URL = 'http://localhost:4000/dev/multi-login';
const DEV_RESET_URL = 'http://localhost:4000/dev/reset';
const CLIENT_URL = 'http://localhost:4173';

/**
 * Email-scoped server reset. Use this in `beforeEach` for specs that need a clean DB slate
 * for the test's emails — passing the emails restricts deletion to those users' rows so
 * /dev/reset in one worker no longer wipes session/user data for tests running concurrently
 * in other workers.
 */
export async function resetServerForEmails(emails: string[]): Promise<void> {
    const res = await fetch(DEV_RESET_URL, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails }),
    });
    if (!res.ok) {
        throw new Error(`dev/reset ${res.status}: ${await res.text()}`);
    }
}

/**
 * Tear a context down without letting it fail an already-passing test. Two load-induced hazards
 * are neutralised here: (1) a live EventSource (SSE) keeps the context's network alive, so we go
 * offline first to drop the keep-alive; (2) under full-suite saturation `ctx.close()` itself could
 * still hang past the 30s test timeout ("gracefully close start" never completing), so we bound it
 * — if graceful close doesn't finish in 5s we stop waiting and let the worker reap the context at
 * process exit. The test body has already run by the time any caller invokes this in its finally,
 * so a slow teardown must never turn a green test red.
 */
export async function closeContextQuietly(ctx: BrowserContext): Promise<void> {
    await ctx.setOffline(true).catch(() => {});
    await Promise.race([ctx.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 5_000))]);
}

export async function withOneLoggedInDevice(browser: Browser, email: string, fn: (page: Page) => Promise<void>): Promise<void> {
    const ctx = await browser.newContext();
    try {
        const page = await loginAs(ctx, email);
        await fn(page);
    } finally {
        await closeContextQuietly(ctx);
    }
}

export async function withTwoLoggedInDevices(browser: Browser, email: string, fn: (page1: Page, page2: Page) => Promise<void>): Promise<void> {
    // Pre-create the user so parallel logins don't race on user creation
    await fetchDevSessionCookie(email);
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    try {
        const [page1, page2] = await Promise.all([loginAs(ctx1, email), loginAs(ctx2, email)]);
        await fn(page1, page2);
    } finally {
        await Promise.all([closeContextQuietly(ctx1), closeContextQuietly(ctx2)]);
    }
}

interface MultiLoginCookie {
    name: string;
    value: string;
    domain: string;
    path: string;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Strict' | 'Lax' | 'None';
    expires: number;
}

interface MultiLoginResponse {
    ok: true;
    sessions: Array<{ email: string; userId: string; rawToken: string }>;
    cookies: MultiLoginCookie[];
}

/**
 * Create one Better Auth session for each email and return the cookies that put the device
 * into a multi-session state. Mirrors the cookie shape that better-auth's `multiSession`
 * plugin produces: one `better-auth.session_token` cookie for the active account plus a
 * `better-auth.session_token_multi-<rawToken>` cookie per session.
 */
export async function fetchDevMultiSessionCookies(emails: string[], activeIndex = 0): Promise<MultiLoginResponse> {
    const res = await fetch(DEV_MULTI_LOGIN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails, activeIndex }),
    });
    if (!res.ok) {
        throw new Error(`Dev multi-login failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as MultiLoginResponse;
}

async function bootMultiSessionDevice(context: BrowserContext, cookies: MultiLoginCookie[]): Promise<Page> {
    await context.addCookies(cookies);
    await pinEditorModeToDialog(context);
    const page = await context.newPage();
    // /auth/callback hydrates IDB (upsertAccount + setActiveAccount) for whichever session is currently
    // active per the `better-auth.session_token` cookie, then redirects to /. The other multi-session
    // cookies are picked up later by useAccounts.listDeviceSessions when it queries the server.
    await page.goto(`${CLIENT_URL}/auth/callback`);
    await page.waitForURL(`${CLIENT_URL}/inbox`);
    await page.waitForFunction(() => typeof (window as unknown as { __gtd?: unknown }).__gtd !== 'undefined');
    return page;
}

/**
 * Sign two distinct accounts into a single BrowserContext (one "device") using the dev-only
 * multi-login endpoint. The first email becomes the active account; both appear in
 * `multiSession.listDeviceSessions()` and both get a `deviceUsers` row server-side as soon
 * as authenticated requests fire under each session.
 */
interface AccountIdentity {
    email: string;
    userId: string;
    rawToken: string;
}

export async function withTwoAccountsOnOneDevice(
    browser: Browser,
    emails: [string, string],
    fn: (page: Page, accounts: { active: AccountIdentity; secondary: AccountIdentity }) => Promise<void>,
    // Pass { serviceWorkers: 'block' } when the test intercepts API calls with page.route — once
    // the PWA's service worker controls the page, routed requests bypass Playwright's interception.
    contextOptions?: Parameters<Browser['newContext']>[0],
): Promise<void> {
    const { sessions, cookies } = await fetchDevMultiSessionCookies(emails);
    const ctx = await browser.newContext(contextOptions);
    try {
        const page = await bootMultiSessionDevice(ctx, cookies);
        const active = sessions[0];
        const secondary = sessions[1];
        if (!active || !secondary) {
            throw new Error('multi-login response missing one or both sessions');
        }
        await fn(page, { active, secondary });
    } finally {
        await closeContextQuietly(ctx);
    }
}
