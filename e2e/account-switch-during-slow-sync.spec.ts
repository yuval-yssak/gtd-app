import { expect, type Page, type Route, test } from '@playwright/test';
import { withTwoAccountsOnOneDevice } from './helpers/context';
import { CLIENT_URL } from './helpers/env';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

/**
 * A sync pass that outlives the session gate's 10s timeout (a phone on a slow network, an API waking
 * from scale-to-zero) used to undo an account switch: the switch's IDB write ran while the pass was
 * still going, then the pass pivoted the active pointer to the next account it synced and, at the
 * end, restored the account it started on — so the next boot came up on the wrong account. Here a
 * held `/sync/pull` keeps a pass open past the (shrunk) timeout.
 */

/** A promise the test settles by hand (Promise.withResolvers is ES2024, past this package's lib). */
function deferred<T>() {
    // let: the executor is the only place the resolver is handed out.
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}

/** Holds the next request matching `url` until `release()` is called. */
async function holdNextRequest(page: Page, url: string) {
    const parked = deferred<Route>();
    const isParked = { value: false };
    // Parked, not awaited inside the handler, so the test decides when the request goes on.
    const park = (route: Route) => {
        isParked.value = true;
        parked.resolve(route);
    };
    await page.route(url, park, { times: 1 });
    return {
        reached: parked.promise.then(() => undefined),
        release: async () => (await parked.promise).continue(),
        /** Stops holding: routes outlive navigations, so an unfired hold would park the next page's boot pull. */
        stopHolding: () => page.unroute(url, park),
        /** A parked request never continued blocks the context's close; its page may already be gone. */
        releaseIfParked: async () => {
            if (isParked.value) {
                await (await parked.promise).continue().catch(() => undefined);
            }
        },
    };
}

/**
 * Answers the switch's hard reload with 204 No Content, which cancels the navigation and keeps the
 * old page — and its still-running pass — alive, so the test decides when that page dies.
 */
async function deferSwitchReload(page: Page) {
    const reloadRequested = deferred<void>();
    await page.route(
        (url) => url.origin === CLIENT_URL && url.pathname === '/settings',
        async (route) => {
            reloadRequested.resolve();
            await route.fulfill({ status: 204 });
        },
        { times: 1 },
    );
    // Wrapped: an async function returning the bare promise would make the caller's await wait for the reload itself.
    return { requested: reloadRequested.promise };
}

/** Reads one IndexedDB store straight from the page — no app code, so no intended-account resolution. */
function readStore<T>(page: Page, store: 'accounts' | 'activeAccount') {
    return page.evaluate(
        (storeName) =>
            new Promise<T[]>((resolve, reject) => {
                const open = indexedDB.open('gtd-app');
                open.onerror = () => reject(open.error);
                open.onsuccess = () => {
                    const read = open.result.transaction(storeName).objectStore(storeName).getAll();
                    read.onerror = () => reject(read.error);
                    read.onsuccess = () => {
                        open.result.close();
                        resolve(read.result);
                    };
                };
            }),
        store,
    );
}

/** The order a sync pass walks the accounts in: oldest-added first (`getAllAccounts`). */
async function accountsInSyncOrder(page: Page) {
    const accounts = await readStore<{ id: string; addedAt: number }>(page, 'accounts');
    return accounts.sort((a, b) => a.addedAt - b.addedAt).map((account) => account.id);
}

/**
 * IDB's stored active pointer. In the page that made the pick, `gtd.getActiveAccountId` answers with
 * the pick itself (the settled read resolves to the intended account), whatever IDB holds.
 */
async function storedActiveAccountId(page: Page) {
    const [active] = await readStore<{ userId: string }>(page, 'activeAccount');
    return active?.userId;
}

/**
 * Picks `userId` in the account switcher. Waits first for the switcher to mark `currentUserId` as
 * current: its accounts load asynchronously, and a click landing before that re-render is lost.
 * Resolves once the click lands, not when the switch's hard reload does.
 */
async function pickAccount(page: Page, userId: string, currentUserId: string) {
    await page.getByTestId('accountSwitcherTrigger').locator('visible=true').first().click();
    await expect(page.locator(`[data-testid="accountSwitcherItem-${currentUserId}"][data-current]`)).toBeVisible();
    // Enter, not a click: the menu can drop a pointer click that lands as it finishes opening. It starts
    // the switch's hard reload; without noWaitAfter Playwright can block ~20s under load on that
    // navigation (which the spec either awaits itself or cancels with a 204).
    await page.getByTestId(`accountSwitcherItem-${userId}`).press('Enter', { noWaitAfter: true });
}

/**
 * Loads Settings with the session gate's timeout shrunk as early as the harness allows: the real 10s
 * is paid by every gated task queued behind the held pass (the timeout is fixed when a task queues),
 * and the race only needs it to fire before the pass ends.
 */
async function loadSettingsWithShortGateTimeout(page: Page, load: () => Promise<unknown>) {
    await load();
    await gtd.setSessionGateTimeoutMs(page, 500);
    // Queued behind the boot pass, so once it resolves no pass is in flight.
    await gtd.pull(page);
}

/** Settings booted on `userId` with no sync pass in flight and a short gate timeout. */
async function settleOnAccount(page: Page, userId: string) {
    await loadSettingsWithShortGateTimeout(page, () => page.goto(`${CLIENT_URL}/settings`));
    const startUserId = await gtd.getActiveAccountId(page);
    if (startUserId && startUserId !== userId) {
        // Every later step must run on the page the switch's hard reload brings up, not the old one.
        await loadSettingsWithShortGateTimeout(page, async () => {
            const reloaded = page.waitForEvent('load');
            await pickAccount(page, userId, startUserId);
            await reloaded;
        });
    }
    expect(await gtd.getActiveAccountId(page)).toBe(userId);
}

/** Starts a pass and holds its first pull, then switches from `currentUserId` to `userId` with the switch's reload cancelled. */
async function switchDuringSlowPass(page: Page, userId: string, currentUserId: string) {
    const firstPull = await holdNextRequest(page, '**/sync/pull?*');
    // Settles either way: past the gate's timeout, overlapping passes pivot the shared session cookie
    // under each other and a pull can fail its session check (a known window) — the account the
    // device lands on is what these specs assert, not whether that pass finished cleanly.
    const slowPass = gtd.pull(page).catch(() => undefined);
    await firstPull.reached;
    const switchReload = await deferSwitchReload(page);
    await pickAccount(page, userId, currentUserId);
    await switchReload.requested;
    return { releaseFirstPull: firstPull.release, slowPass };
}

function emailRow(email: string) {
    return `${email.split('@')[0]} · ${email}`;
}

/** The device's two accounts in the order a pass syncs them, with the emails Settings shows for them. */
async function accountsBySyncOrder(page: Page, accounts: { active: { userId: string; email: string }; secondary: { userId: string; email: string } }) {
    // The boot mirrors the device's sessions into IDB shortly after load.
    await expect.poll(async () => (await accountsInSyncOrder(page)).length).toBe(2);
    const [firstId, nextId] = await accountsInSyncOrder(page);
    const byId = new Map([accounts.active, accounts.secondary].map((account) => [account.userId, account]));
    const first = firstId ? byId.get(firstId) : undefined;
    const next = nextId ? byId.get(nextId) : undefined;
    if (!first || !next) {
        throw new Error('expected the two seeded accounts on the device');
    }
    return { first, next };
}

function twoAccountEmails(label: string): [string, string] {
    const ts = uniqueStamp();
    return [`${label}-a-${ts}@example.com`, `${label}-b-${ts}@example.com`];
}

test('a switch to the account a slow pass syncs next survives the pass restoring the account it started on', async ({ browser }) => {
    await withTwoAccountsOnOneDevice(browser, twoAccountEmails('slow-switch-fwd'), async (page, accounts) => {
        await page.goto(`${CLIENT_URL}/settings`);
        const { first, next } = await accountsBySyncOrder(page, accounts);
        await settleOnAccount(page, first.userId);

        const { releaseFirstPull, slowPass } = await switchDuringSlowPass(page, next.userId, first.userId);
        await releaseFirstPull();
        await slowPass;
        expect(await storedActiveAccountId(page)).toBe(next.userId);

        await page.reload();
        await expect(page.getByText(emailRow(next.email))).toBeVisible();
    });
});

test('a switch back to the account a slow pass already synced survives the page dying before the pass ends', async ({ browser }) => {
    await withTwoAccountsOnOneDevice(browser, twoAccountEmails('slow-switch-back'), async (page, accounts) => {
        await page.goto(`${CLIENT_URL}/settings`);
        const { first, next } = await accountsBySyncOrder(page, accounts);
        // Start on the account the pass syncs SECOND, so the switch target is the one it syncs first.
        await settleOnAccount(page, next.userId);

        const { releaseFirstPull, slowPass } = await switchDuringSlowPass(page, first.userId, next.userId);
        // A pass that keeps going pivots to `next` and pulls for it — held here, so the reload below
        // kills the page before the pass could restore anything. A pass that stops just ends.
        const nextPull = await holdNextRequest(page, '**/sync/pull?*');
        await releaseFirstPull();
        await Promise.race([nextPull.reached, slowPass]);
        await nextPull.stopHolding();

        await page.reload();
        await nextPull.releaseIfParked();
        await expect(page.getByText(emailRow(first.email))).toBeVisible();
        expect(await gtd.getActiveAccountId(page)).toBe(first.userId);
    });
});
