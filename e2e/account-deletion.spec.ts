import * as fs from 'node:fs/promises';
import type { Download, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { resetServerForEmails, withOneLoggedInDevice, withTwoAccountsOnOneDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Account deletion + data export. Deleted users must evaporate from every device — the one
// receiving the SSE `account-deleted` event live, AND one that was offline at the time and
// only learns about it from the unauthenticated tombstone probe (`GET /auth/user-status`) on
// its next reconnect. Other accounts signed in on the same device must be untouched.

const CLIENT_URL = 'http://localhost:4173';
const API_URL = 'http://localhost:4000';

/** Timestamp alone collides when two workers start the same case in the same millisecond (`--repeat-each`); the random tail keeps the accounts apart. */
function uniqueEmail(prefix: string): string {
    return `${prefix}-${dayjs().valueOf()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

interface UserIdbFootprint {
    items: number;
    accountPresent: boolean;
    syncCursorPresent: boolean;
    deviceMetaPresent: boolean;
}

/** Evaporations navigate the page; a read that lands mid-navigation loses its execution context. Retry on the next document. */
async function readUserIdbFootprint(page: Page, userId: string, attempt = 0): Promise<UserIdbFootprint> {
    try {
        return await readUserIdbFootprintOnce(page, userId);
    } catch (err) {
        if (attempt < 5 && String(err).includes('Execution context was destroyed')) {
            return readUserIdbFootprint(page, userId, attempt + 1);
        }
        throw err;
    }
}

async function readUserIdbFootprintOnce(page: Page, userId: string): Promise<UserIdbFootprint> {
    // A read that lands right after a navigation would see no harness yet.
    await page.waitForFunction(() => typeof (window as unknown as { __gtd?: unknown }).__gtd !== 'undefined');
    return page.evaluate(async (uid) => {
        type Harness = {
            db: {
                getAllFromIndex(store: 'items', index: 'userId', key: string): Promise<unknown[]>;
                get(store: 'accounts', key: string): Promise<unknown>;
                get(store: 'syncCursors', key: string): Promise<unknown>;
                get(store: 'deviceMeta', key: 'local'): Promise<unknown>;
            };
        };
        const harness = (window as unknown as { __gtd: Harness }).__gtd;
        const [items, account, cursor, deviceMeta] = await Promise.all([
            harness.db.getAllFromIndex('items', 'userId', uid),
            harness.db.get('accounts', uid),
            harness.db.get('syncCursors', uid),
            harness.db.get('deviceMeta', 'local'),
        ]);
        return {
            items: items.length,
            accountPresent: account !== undefined,
            syncCursorPresent: cursor !== undefined,
            deviceMetaPresent: deviceMeta !== undefined,
        };
    }, userId);
}

async function fetchUserStatus(userId: string): Promise<{ status: string; deletedAt?: string }> {
    const res = await fetch(`${API_URL}/auth/user-status?userId=${encodeURIComponent(userId)}`);
    if (!res.ok) {
        throw new Error(`user-status ${res.status}`);
    }
    return (await res.json()) as { status: string; deletedAt?: string };
}

/** Stands in for an admin running `scripts/deleteUser.ts` — same `deleteUserCompletely` underneath. */
async function adminDeleteUser(email: string): Promise<void> {
    const res = await fetch(`${API_URL}/dev/delete-user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
    });
    if (!res.ok) {
        throw new Error(`dev/delete-user ${res.status}: ${await res.text()}`);
    }
}

async function activeAccountId(page: Page): Promise<string> {
    const userId = await gtd.getActiveAccountId(page);
    if (!userId) {
        throw new Error('expected an active account');
    }
    return userId;
}

/**
 * After a deletion a tab may reload twice in quick succession (its own evaporation, then the other
 * tab's cross-tab broadcast — both land on the same destination). Reads across that window retry.
 */
async function settledActiveAccountId(page: Page): Promise<string | null> {
    try {
        return await gtd.getActiveAccountId(page);
    } catch (err) {
        if (String(err).includes('Execution context was destroyed')) {
            return null;
        }
        throw err;
    }
}

/** The evaporated account must be gone from IDB while the device-scoped `deviceMeta` survives. */
async function expectEvaporated(page: Page, userId: string): Promise<void> {
    await expect
        .poll(() => readUserIdbFootprint(page, userId), { timeout: 15_000 })
        .toEqual({
            items: 0,
            accountPresent: false,
            syncCursorPresent: false,
            deviceMetaPresent: true,
        });
}

test.describe('account deletion', () => {
    test('live device: an admin deletion reaches the open tab over SSE, wipes the account and lands on /login', async ({ browser }) => {
        const email = uniqueEmail('delete-live');
        await resetServerForEmails([email]);
        await withOneLoggedInDevice(browser, email, async (page) => {
            await gtd.collect(page, 'Doomed item');
            await gtd.flush(page);
            const userId = await activeAccountId(page);
            expect((await readUserIdbFootprint(page, userId)).items).toBe(1);
            expect(await fetchUserStatus(userId)).toEqual({ status: 'active' });
            // "Live" means the SSE channel is open — right after login it can still be connecting.
            await expect.poll(() => gtd.sseChannelUserIds(page), { timeout: 15_000 }).toContain(userId);

            await adminDeleteUser(email);

            await page.waitForURL(`${CLIENT_URL}/login`, { timeout: 15_000 });
            await expectEvaporated(page, userId);
            const status = await fetchUserStatus(userId);
            expect(status.status).toBe('deleted');
            expect(dayjs(status.deletedAt).isValid()).toBe(true);
        });
    });

    test('offline device (the year-old-device case): deleted while offline, evaporates on reconnect via the tombstone probe', async ({ browser }) => {
        const email = uniqueEmail('delete-offline');
        await resetServerForEmails([email]);
        await withOneLoggedInDevice(browser, email, async (page) => {
            await gtd.collect(page, 'Item on a device that goes dark');
            await gtd.flush(page);
            const userId = await activeAccountId(page);

            // Offline: the SSE channel is torn down, so the live broadcast cannot reach this tab.
            await page.context().setOffline(true);
            await adminDeleteUser(email);
            // Still showing cached data — nothing has told the device yet.
            expect((await readUserIdbFootprint(page, userId)).items).toBe(1);

            // Reconnect: the session is gone server-side, so the only thing that can tell this
            // device its account was deleted (rather than merely expired) is the tombstone.
            await page.context().setOffline(false);

            await page.waitForURL(`${CLIENT_URL}/login`, { timeout: 20_000 });
            await expectEvaporated(page, userId);
        });
    });

    test('multi-account device: deleting the secondary account leaves the active account and its data intact', async ({ browser }) => {
        const emails: [string, string] = [uniqueEmail('delete-keep'), uniqueEmail('delete-gone')];
        await resetServerForEmails(emails);
        await withTwoAccountsOnOneDevice(browser, emails, async (page, { active, secondary }) => {
            await gtd.collect(page, 'Survivor item');
            await gtd.flush(page);
            // Both accounts are listed on the device, and the secondary's SSE channel is open, so the
            // deletion below reaches this tab live (the no-channel case is the offline spec above plus
            // the orchestrator's dead-session probe, unit-tested in multiUserSync.test.ts).
            await expect.poll(() => readUserIdbFootprint(page, secondary.userId).then((f) => f.accountPresent), { timeout: 15_000 }).toBe(true);
            await expect.poll(() => gtd.sseChannelUserIds(page), { timeout: 15_000 }).toContain(secondary.userId);

            await adminDeleteUser(secondary.email);

            await expectEvaporated(page, secondary.userId);
            // The active account never left the app: same route, same data, same session.
            expect(page.url()).not.toContain('/login');
            const survivor = await readUserIdbFootprint(page, active.userId);
            expect(survivor.items).toBe(1);
            expect(survivor.accountPresent).toBe(true);
            expect(await gtd.getActiveAccountId(page)).toBe(active.userId);
            expect(await fetchUserStatus(active.userId)).toEqual({ status: 'active' });
            expect((await fetchUserStatus(secondary.userId)).status).toBe('deleted');
        });
    });

    test('self-service: Settings → Delete my account requires typing the email, then wipes the account and lands on /login', async ({ browser }) => {
        const email = uniqueEmail('delete-self');
        await resetServerForEmails([email]);
        await withOneLoggedInDevice(browser, email, async (page) => {
            await gtd.collect(page, 'Self-deleted item');
            await gtd.flush(page);
            const userId = await activeAccountId(page);

            await page.goto(`${CLIENT_URL}/settings`);
            await page.getByTestId('deleteAccountButton').click();
            const dialog = page.getByTestId('deleteAccountDialog');
            await expect(dialog).toBeVisible();
            const confirmButton = page.getByTestId('confirmDeleteAccountButton');
            await expect(confirmButton).toBeDisabled();

            // A wrong address keeps the irreversible button disabled.
            await page.getByTestId('deleteAccountEmailInput').locator('input').fill('someone-else@example.com');
            await expect(confirmButton).toBeDisabled();
            await page.getByTestId('deleteAccountEmailInput').locator('input').fill(email);
            await expect(confirmButton).toBeEnabled();
            await confirmButton.click();

            await page.waitForURL(`${CLIENT_URL}/login`, { timeout: 15_000 });
            await expectEvaporated(page, userId);
            expect((await fetchUserStatus(userId)).status).toBe('deleted');
        });
    });
});

test.describe('account deletion — second tab on the same device', () => {
    test('a second open tab of the deleted account also lands on /login (SSE or the cross-tab broadcast, whichever arrives first)', async ({ browser }) => {
        const email = uniqueEmail('delete-two-tabs');
        await resetServerForEmails([email]);
        await withOneLoggedInDevice(browser, email, async (page) => {
            await gtd.collect(page, 'Seen in both tabs');
            await gtd.flush(page);
            const userId = await activeAccountId(page);
            const secondTab = await page.context().newPage();
            try {
                await secondTab.goto(`${CLIENT_URL}/inbox`);
                await expect(secondTab.getByText('Seen in both tabs')).toBeVisible();
                await expect.poll(() => gtd.sseChannelUserIds(secondTab), { timeout: 15_000 }).toContain(userId);

                await page.goto(`${CLIENT_URL}/settings`);
                await page.getByTestId('deleteAccountButton').click();
                await page.getByTestId('deleteAccountEmailInput').locator('input').fill(email);
                await page.getByTestId('confirmDeleteAccountButton').click();

                // The deleting tab navigates; the OTHER tab must not keep rendering a deleted account.
                await page.waitForURL(`${CLIENT_URL}/login`, { timeout: 15_000 });
                await secondTab.waitForURL(`${CLIENT_URL}/login`, { timeout: 15_000 });
                await expectEvaporated(secondTab, userId);
            } finally {
                await secondTab.close().catch(() => undefined);
            }
        });
    });
});

test.describe('account deletion — two accounts, two tabs', () => {
    test('deleting the ACTIVE account lands both tabs on the surviving account’s inbox, never the public landing page', async ({ browser }) => {
        const emails: [string, string] = [uniqueEmail('delete-active-two-tabs'), uniqueEmail('survivor-two-tabs')];
        await resetServerForEmails(emails);
        await withTwoAccountsOnOneDevice(browser, emails, async (page, { active, secondary }) => {
            await gtd.collect(page, 'Belongs to the account being deleted');
            await gtd.flush(page);
            await expect.poll(() => readUserIdbFootprint(page, secondary.userId).then((f) => f.accountPresent), { timeout: 15_000 }).toBe(true);
            const secondTab = await page.context().newPage();
            try {
                await secondTab.goto(`${CLIENT_URL}/inbox`);
                await expect(secondTab.getByText('Belongs to the account being deleted')).toBeVisible();
                await expect.poll(() => gtd.sseChannelUserIds(secondTab), { timeout: 15_000 }).toContain(active.userId);

                await adminDeleteUser(active.email);

                // Both tabs pivot to the survivor and boot on an authenticated route — a tab that
                // reloaded before the survivor's pointer + cookie were written would show / or /login.
                await page.waitForURL(`${CLIENT_URL}/inbox`, { timeout: 15_000 });
                await secondTab.waitForURL(`${CLIENT_URL}/inbox`, { timeout: 15_000 });
                await expectEvaporated(page, active.userId);
                await expectEvaporated(secondTab, active.userId);
                await expect.poll(() => settledActiveAccountId(page), { timeout: 15_000 }).toBe(secondary.userId);
                await expect.poll(() => settledActiveAccountId(secondTab), { timeout: 15_000 }).toBe(secondary.userId);
                // Neither tab is stranded on the public landing page or the login card.
                await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
                await expect(secondTab.getByRole('heading', { name: 'Inbox' })).toBeVisible();
            } finally {
                await secondTab.close().catch(() => undefined);
            }
        });
    });
});

test.describe('data export', () => {
    test('Settings → Download my data saves a JSON file with the account’s data and no credentials', async ({ browser }) => {
        const email = uniqueEmail('export');
        await resetServerForEmails([email]);
        await withOneLoggedInDevice(browser, email, async (page) => {
            await gtd.collect(page, 'Exported item title');
            await gtd.flush(page);
            const userId = await activeAccountId(page);

            await page.goto(`${CLIENT_URL}/settings`);
            const downloadPromise = page.waitForEvent('download', { timeout: 15_000 });
            await page.getByTestId('downloadMyDataButton').click();
            const download: Download = await downloadPromise;

            expect(download.suggestedFilename()).toBe(`done-export-${dayjs().format('YYYY-MM-DD')}.json`);
            const payload = JSON.parse(await fs.readFile(await download.path(), 'utf8')) as {
                format: string;
                user: { _id: string; email: string } | null;
                collections: Record<string, Array<Record<string, unknown>>>;
                omitted: Record<string, { reason: string; count: number }>;
            };
            expect(payload.format).toBe('done-export/1');
            expect(payload.user?._id).toBe(userId);
            expect(payload.user?.email).toBe(email);
            expect(payload.collections.items?.map((item) => item.title)).toEqual(['Exported item title']);
            // The session that made the request is listed, minus its token; the op log is only counted.
            expect(payload.collections.session?.length).toBeGreaterThanOrEqual(1);
            expect(payload.collections.session?.[0]).not.toHaveProperty('token');
            expect(payload.omitted.operations?.count).toBeGreaterThanOrEqual(1);
            // The account still exists afterwards — export is read-only.
            expect(await fetchUserStatus(userId)).toEqual({ status: 'active' });
        });
    });
});
