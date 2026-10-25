import { expect, type Page, request, test } from '@playwright/test';
import dayjs from 'dayjs';
import { resetServerForEmails, withTwoAccountsOnOneDevice } from './helpers/context';
import { API_URL, CLIENT_URL } from './helpers/env';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

// Active-account switching is now local-first ONLY (IDB write + hard reload — no network), so it
// must work fully offline: the target account's cached data renders from IDB, and the server-side
// Better Auth active-session cookie is reconciled to IDB's choice by reconcileActiveSessionCookie
// once the network returns. These tests pin that contract, plus the expired-session variant where
// the reconcile surfaces the reauth dialog instead of silently showing stale data.

const API_ORIGIN = API_URL;
const DEV_SEED_ENTITY_URL = `${API_ORIGIN}/dev/reassign/seed-entity`;

/**
 * Simulates offline by aborting only the API origin. The dev server has no service worker, so a
 * real context.setOffline() could not serve the app shell across the post-switch hard reload
 * (see the comment in offline.spec.ts) — aborting just port 4000 keeps the shell loadable while
 * every server round-trip fails like a dead network.
 */
async function blockApiOrigin(page: Page): Promise<void> {
    await page.route(`${API_ORIGIN}/**`, (route) => route.abort('failed'));
}

async function unblockApiOrigin(page: Page): Promise<void> {
    await page.unroute(`${API_ORIGIN}/**`);
}

async function seedItemOnServer(userId: string, title: string): Promise<string> {
    const id = `seed-${Math.random().toString(36).slice(2, 10)}`;
    const now = dayjs().toISOString();
    const doc = { _id: id, user: userId, status: 'inbox', title, createdTs: now, updatedTs: now };
    const res = await fetch(DEV_SEED_ENTITY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'items', doc }),
    });
    if (!res.ok) {
        throw new Error(`seed item ${res.status}: ${await res.text()}`);
    }
    return id;
}

/** Opens the visible AccountSwitcher menu instance and clicks the target account, awaiting the hard reload. */
async function switchAccountViaMenu(page: Page, targetUserId: string): Promise<void> {
    const trigger = page.getByTestId('accountSwitcherTrigger').locator('visible=true').first();
    await trigger.click();
    const target = page.getByTestId(`accountSwitcherItem-${targetUserId}`);
    await target.waitFor({ state: 'visible' });
    await Promise.all([page.waitForLoadState('load'), target.click()]);
}

/**
 * Revokes one of the device's Better Auth sessions out of band (an expiry or a remote sign-out).
 * Sent through the context's request client: it shares the device's cookies but bypasses
 * `page.route`, so it works while the API is blocked — and the page itself never sees the revoke.
 */
async function revokeSessionOutOfBand(page: Page, sessionToken: string): Promise<void> {
    const res = await page.context().request.post(`${API_ORIGIN}/auth/multi-session/revoke`, {
        // Better Auth's CSRF check wants a trusted Origin on cookie-authenticated POSTs.
        headers: { Origin: CLIENT_URL },
        data: { sessionToken },
    });
    if (!res.ok()) {
        throw new Error(`revoke failed: ${res.status()}`);
    }
}

/**
 * Points the device's active-session cookie at `sessionToken`, as a sync pass's pivot does — out of
 * band, like `revokeSessionOutOfBand`, so `delayCookiePivots` holds back only the app's own pivots.
 */
async function pivotCookieOutOfBand(page: Page, sessionToken: string): Promise<void> {
    const res = await page.context().request.post(`${API_ORIGIN}/auth/multi-session/set-active`, {
        headers: { Origin: CLIENT_URL },
        data: { sessionToken },
    });
    if (!res.ok()) {
        throw new Error(`set-active failed: ${res.status()}`);
    }
}

const ACTIVE_SESSION_COOKIE = 'better-auth.session_token';

/**
 * Revokes `revokedToken` from a second client holding this device's cookies, but with
 * `actingToken`'s session active. Better Auth moves a client's active cookie off a session that
 * client itself revokes, so revoking from the device would heal the cookie at once. Revoked from
 * elsewhere, the device's cookie stays on the dead session, which is the state a sync pass leaves
 * when its pivot lands just before a revoke completes.
 */
async function revokeSessionElsewhere(page: Page, revokedToken: string, actingToken: string): Promise<void> {
    const deviceCookies = await page.context().cookies(API_ORIGIN);
    const actingCookie = deviceCookies.find((cookie) => cookie.name.endsWith(`_multi-${actingToken.toLowerCase()}`));
    if (!actingCookie) {
        throw new Error('expected a multi-session cookie for the acting account');
    }
    const cookies = deviceCookies.map((cookie) => (cookie.name === ACTIVE_SESSION_COOKIE ? { ...cookie, value: actingCookie.value } : cookie));
    const elsewhere = await request.newContext({ storageState: { cookies, origins: [] } });
    try {
        const res = await elsewhere.post(`${API_ORIGIN}/auth/multi-session/revoke`, { headers: { Origin: CLIENT_URL }, data: { sessionToken: revokedToken } });
        if (!res.ok()) {
            throw new Error(`revoke failed: ${res.status()}`);
        }
    } finally {
        await elsewhere.dispose();
    }
}

/** Collects every navigation to /login from now on. */
function recordLoginNavigations(page: Page): string[] {
    const navigations: string[] = [];
    page.on('request', (outgoing) => {
        if (outgoing.isNavigationRequest() && new URL(outgoing.url()).pathname === '/login') {
            navigations.push(outgoing.url());
        }
    });
    return navigations;
}

/**
 * Holds back the app's own cookie pivots after the next load, so the route guard's session check
 * always runs against the dead cookie before the boot reconcile re-points it — the losing order
 * of the race this pins, deterministically.
 */
async function delayCookiePivots(page: Page): Promise<void> {
    await page.route(`${API_ORIGIN}/auth/multi-session/set-active`, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        await route.continue();
    });
}

/** Reads the server's view of the active Better Auth session via the page (cookies included). */
async function fetchActiveSessionUserId(page: Page): Promise<string | null> {
    return page.evaluate(async (origin) => {
        const res = await fetch(`${origin}/auth/get-session`, { credentials: 'include' });
        if (!res.ok) {
            return null;
        }
        const body = (await res.json()) as { user?: { id?: string } } | null;
        return body?.user?.id ?? null;
    }, API_ORIGIN);
}

/** Waits for the multi-account boot to settle (one sync cursor per account) before acting. */
async function waitForBothCursors(page: Page): Promise<void> {
    await expect.poll(async () => new Set((await gtd.syncState(page)).syncCursors.map((c) => c.userId)).size, { timeout: 15_000 }).toBe(2);
}

/**
 * Raw IDB probe for an item row by id. Needed pre-switch because `gtd.listItems()` scopes to the
 * ACTIVE account — the row we're waiting for belongs to the (not-yet-active) secondary account.
 */
async function idbHasItem(page: Page, itemId: string): Promise<boolean> {
    return page.evaluate(
        (id) =>
            new Promise<boolean>((resolve) => {
                const openReq = indexedDB.open('gtd-app');
                openReq.onerror = () => resolve(false);
                openReq.onsuccess = () => {
                    const idb = openReq.result;
                    try {
                        const getReq = idb.transaction('items', 'readonly').objectStore('items').get(id);
                        getReq.onsuccess = () => {
                            resolve(Boolean(getReq.result));
                            idb.close();
                        };
                        getReq.onerror = () => {
                            resolve(false);
                            idb.close();
                        };
                    } catch {
                        resolve(false);
                        idb.close();
                    }
                };
            }),
        itemId,
    );
}

test.describe('offline account switch', () => {
    test('switching while the API is unreachable renders the target account from IDB; the cookie realigns on reconnect', async ({ browser }) => {
        const ts = uniqueStamp();
        const emailA = `off-switch-a-${ts}@example.com`;
        const emailB = `off-switch-b-${ts}@example.com`;
        await resetServerForEmails([emailA, emailB]);
        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { secondary }) => {
            await waitForBothCursors(page);
            // Put an item under B on the server, then reload so the boot orchestrator pulls it
            // into IDB — that cached row is what the offline switch must render.
            const seededId = await seedItemOnServer(secondary.userId, 'B item cached');
            await page.reload();
            // Wait for the boot orchestrator to settle again post-reload before polling for the
            // pulled row — B's pull pass can land late on a busy machine. The raw-IDB probe is
            // required here: gtd.listItems() scopes to the active account (still A).
            await waitForBothCursors(page);
            await expect.poll(() => idbHasItem(page, seededId), { timeout: 30_000 }).toBe(true);

            await blockApiOrigin(page);
            await switchAccountViaMenu(page, secondary.userId);

            // The switch completed with zero server round-trips: B is the active account…
            await expect.poll(() => gtd.getActiveAccountIdAcrossReload(page), { timeout: 10_000 }).toBe(secondary.userId);
            // …and B's data renders from the IDB cache.
            const items = await gtd.listItems(page);
            expect(items.some((i) => i._id === seededId)).toBe(true);
            // B's session is valid (just unreachable) — no reauth dialog; the cookie reconcile
            // swallows the network error and defers to the next online pass.
            await expect(page.getByTestId('accountReauthDialog')).toBeHidden();

            // Reconnect: the boot-path reconcile converges the Better Auth cookie onto IDB's
            // choice (B), so session-scoped requests resolve as the right user again.
            await unblockApiOrigin(page);
            await page.reload();
            await expect.poll(() => fetchActiveSessionUserId(page), { timeout: 15_000 }).toBe(secondary.userId);
            await expect(page.getByTestId('accountReauthDialog')).toBeHidden();
        });
    });

    // A sync pass can pivot the cookie onto a session revoked a moment earlier (its session list
    // predates the revoke), and a dropped connection then keeps the restore pivot from undoing
    // it. That leaves one account needing re-login, never "signed out": the app must stay up and
    // raise the reauth dialog instead of bouncing to /login while another account is still live.
    test('a cookie left on a revoked session, with another live account on the device, raises the reauth dialog — not the login page', async ({ browser }) => {
        const stamp = uniqueStamp();
        const emailA = `dead-cookie-a-${stamp}@example.com`;
        const emailB = `dead-cookie-b-${stamp}@example.com`;
        await resetServerForEmails([emailA, emailB]);
        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            await waitForBothCursors(page);
            // Hold the app's own pivots first, so a pass still in flight cannot re-point the cookie.
            await delayCookiePivots(page);
            // A pass pivots the cookie onto B; B's session is then revoked from elsewhere.
            await pivotCookieOutOfBand(page, secondary.rawToken);
            await revokeSessionElsewhere(page, secondary.rawToken, active.rawToken);
            // Precondition: the cookie now authenticates as nobody.
            expect(await fetchActiveSessionUserId(page)).toBeNull();
            const loginNavigations = recordLoginNavigations(page);

            await page.reload();

            // The dialog for B is raised by the sync pass, which starts only after the held-back reconcile
            // pivot — so it shows after the guard's session check has already run.
            await expect(page.getByTestId('accountReauthDialog')).toBeVisible({ timeout: 15_000 });
            expect(loginNavigations).toEqual([]);
        });
    });

    test('offline switch to a revoked-session account: cached data offline, reauth dialog on reconnect, Re-login disabled while offline', async ({
        browser,
    }) => {
        const ts = uniqueStamp();
        const emailA = `off-revoked-a-${ts}@example.com`;
        const emailB = `off-revoked-b-${ts}@example.com`;
        await resetServerForEmails([emailA, emailB]);
        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { secondary }) => {
            await waitForBothCursors(page);

            // Offline first, then revoke B's session out of band (an expiry / remote sign-out): the
            // device cannot learn of it. Revoked while the page was online, a sync pass in flight
            // could see B's 401 and raise the reauth dialog before the switch. The device's IDB
            // still lists B, so the switcher still offers it.
            await blockApiOrigin(page);
            await revokeSessionOutOfBand(page, secondary.rawToken);
            await switchAccountViaMenu(page, secondary.userId);

            // Offline: the switch still lands on B with cached data; the revocation is unknowable
            // without the network, so no dialog yet — never a blocked switch.
            await expect.poll(() => gtd.getActiveAccountIdAcrossReload(page), { timeout: 10_000 }).toBe(secondary.userId);
            await expect(page.getByTestId('accountReauthDialog')).toBeHidden();

            // Reconnect: the cookie reconcile finds no live session for B and raises the dialog.
            await unblockApiOrigin(page);
            await page.reload();
            const dialog = page.getByTestId('accountReauthDialog');
            await expect(dialog).toBeVisible({ timeout: 15_000 });
            await expect(dialog.getByText(emailB)).toBeVisible();
            // The app stays on the account the user chose — it needs re-login, it is never swapped for A.
            expect(await gtd.getActiveAccountId(page)).toBe(secondary.userId);
            await expect(dialog.getByTestId('accountReauthDialogRelogin')).toBeEnabled();

            // Going offline flips the dialog into its informative, non-actionable state: Re-login
            // (an OAuth redirect) is disabled with an explanatory hint. setOffline works here —
            // no navigation is needed, we just need the window offline event.
            await page.context().setOffline(true);
            await expect(dialog.getByTestId('accountReauthDialogRelogin')).toBeDisabled();
            await expect(dialog.getByTestId('accountReauthDialogOfflineHint')).toBeVisible();
            await page.context().setOffline(false);
            await expect(dialog.getByTestId('accountReauthDialogRelogin')).toBeEnabled();
        });
    });
});
