import { expect, type Page, type Route, test } from '@playwright/test';
import dayjs from 'dayjs';
import { resetServerForEmails, withOneLoggedInDevice, withTwoAccountsOnOneDevice } from './helpers/context';
import { API_URL, CLIENT_URL } from './helpers/env';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

/**
 * "Lie-fi": the network is so slow that requests never answer, yet the browser still reports
 * online — so no offline guard fires. Every screen must render from the device's IndexedDB copy
 * regardless, and say that copy has not been checked with the server yet. Fully offline already
 * worked (fetch rejects at once); a hanging fetch used to suspend the editor behind the route's
 * fallback until the browser gave up, minutes later.
 */

/** How long a screen may take to render from IndexedDB alone. Far below any network give-up. */
const LOCAL_RENDER_BUDGET_MS = 5_000;

/** Parks every API request without answering it, while the page stays online. */
async function hangApi(page: Page) {
    const parked: Route[] = [];
    const park = (route: Route) => {
        parked.push(route);
    };
    await page.route(`${API_URL}/**`, park);
    return {
        /** Lets the parked requests through and stops parking new ones. */
        release: async () => {
            await page.unroute(`${API_URL}/**`, park);
            // A request parked by a page that has since navigated is gone; continuing it throws.
            await Promise.all(parked.splice(0).map((route) => route.continue().catch(() => undefined)));
        },
    };
}

/**
 * A choppy connection: every API request fails at once (the connection drops mid-request), except
 * the live-update channel, which hangs — it looks connected but delivers nothing, so it never fires
 * the catch-up a reconnect would.
 */
async function dropApiRequests(page: Page) {
    const dropRequest = (route: Route) => route.abort('connectionreset');
    const parkedChannels: Route[] = [];
    await page.route(`${API_URL}/**`, dropRequest);
    // Registered last, so it wins for the live channel — and outlives recoverRequests().
    await page.route(`${API_URL}/sync/events**`, (route) => {
        parkedChannels.push(route);
    });
    return {
        /** The connection recovers for ordinary requests; the parked live channel stays dead. */
        recoverRequests: () => page.unroute(`${API_URL}/**`, dropRequest),
        /** Parked requests block the context's close. */
        releaseChannels: () => Promise.all(parkedChannels.splice(0).map((route) => route.abort().catch(() => undefined))),
    };
}

async function seedCalendarForUser(userId: string, configId: string, displayName: string) {
    const res = await fetch(`${API_URL}/dev/calendar/seed-integration`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Two calendars: with a single one the editor shows a static label instead of the picker.
        body: JSON.stringify({
            userId,
            calendars: [
                { configId, calendarId: 'primary', displayName, isDefault: true },
                { configId: `${configId}-other`, calendarId: 'other', displayName: 'Lie-fi Other', isDefault: false },
            ],
        }),
    });
    if (!res.ok) {
        throw new Error(`seed calendar ${res.status}: ${await res.text()}`);
    }
    return ((await res.json()) as { integrationId: string }).integrationId;
}

async function seedCalendarItemOnServer(userId: string, link: { integrationId: string; configId: string }, title: string) {
    const id = `liefi-${uniqueStamp()}`;
    const now = dayjs().toISOString();
    const start = dayjs().add(1, 'day').hour(9).startOf('hour');
    const doc = {
        _id: id,
        user: userId,
        status: 'calendar',
        title,
        timeStart: start.toISOString(),
        timeEnd: start.add(30, 'minute').toISOString(),
        calendarEventId: `gcal-evt-${id}`,
        calendarIntegrationId: link.integrationId,
        calendarSyncConfigId: link.configId,
        createdTs: now,
        updatedTs: now,
    };
    const res = await fetch(`${API_URL}/dev/reassign/seed-entity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'items', doc }),
    });
    if (!res.ok) {
        throw new Error(`seed item ${res.status}: ${await res.text()}`);
    }
    return id;
}

/** A device that has synced the item and its calendar list once, with a good network. */
async function seedSyncedCalendarItem(page: Page, userId: string, calendarName: string) {
    const configId = `cfg-liefi-${uniqueStamp()}`;
    const integrationId = await seedCalendarForUser(userId, configId, calendarName);
    const itemId = await seedCalendarItemOnServer(userId, { integrationId, configId }, 'Dentist (lie-fi)');
    await gtd.pull(page);
    // The first visit with a working network is what stores the calendar list on the device.
    await page.goto(`${CLIENT_URL}/item/${itemId}`);
    await expect(page.getByTestId('itemPageWrapper').getByRole('combobox', { name: 'Calendar' })).toHaveText(new RegExp(calendarName));
    return itemId;
}

test.describe('lie-fi: the API hangs while the browser reports online', () => {
    test('the item editor renders from the device copy with its stored calendars, marked "Not verified" until the server answers', async ({ browser }) => {
        const stamp = uniqueStamp();
        const emails: [string, string] = [`liefi-item-a-${stamp}@example.com`, `liefi-item-b-${stamp}@example.com`];
        await resetServerForEmails(emails);
        // Multi-session: /calendar/all-sync-configs enumerates the device's Better Auth sessions,
        // which a single dev login does not register.
        await withTwoAccountsOnOneDevice(browser, emails, async (page, { active }) => {
            const itemId = await seedSyncedCalendarItem(page, active.userId, 'Lie-fi Work');
            await expect(page.getByTestId('freshnessBadge')).toHaveCount(0);

            const network = await hangApi(page);
            await page.goto(`${CLIENT_URL}/item/${itemId}`);

            const editor = page.getByTestId('itemPageWrapper');
            await expect(editor).toBeVisible({ timeout: LOCAL_RENDER_BUDGET_MS });
            await expect(editor.getByRole('combobox', { name: 'Calendar' })).toHaveText(/Lie-fi Work/);
            await expect(page.getByTestId('freshnessBadge')).toHaveAttribute('data-freshness', 'unverified');
            // The browser still says online; the status bar says the server has not answered.
            await expect(page.getByTestId('statusBarAwaitingServer')).toBeVisible();

            await network.release();
            await expect(page.getByTestId('freshnessBadge')).toHaveCount(0, { timeout: 15_000 });
            await expect(page.getByTestId('statusBarAwaitingServer')).toHaveCount(0);
        });
    });

    test('the routine editor renders from the device copy while the API hangs', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `liefi-routine-${uniqueStamp()}@example.com`, async (page) => {
            const routine = await gtd.createRoutine(page, {
                title: 'Water plants',
                routineType: 'nextAction',
                rrule: 'FREQ=DAILY',
                template: {},
                active: true,
            });
            await gtd.flush(page);

            const network = await hangApi(page);
            await page.goto(`${CLIENT_URL}/routine/${routine._id}`);
            await expect(page.getByTestId('routinePageWrapper').getByRole('textbox', { name: 'Title' })).toHaveValue('Water plants', {
                timeout: LOCAL_RENDER_BUDGET_MS,
            });
            await network.release();
        });
    });

    test('an edit made offline is marked "Not synced" until its push lands', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `liefi-unsynced-${uniqueStamp()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Call the plumber');
            await gtd.flush(page);
            await page.goto(`${CLIENT_URL}/item/${item._id}`);
            await expect(page.getByTestId('itemPageWrapper')).toBeVisible();
            await expect(page.getByTestId('freshnessBadge')).toHaveCount(0);

            await page.context().setOffline(true);
            await gtd.updateItem(page, { ...item, title: 'Call the plumber about the leak', updatedTs: dayjs().toISOString() });
            await expect(page.getByTestId('freshnessBadge')).toHaveAttribute('data-freshness', 'unsynced');

            await page.context().setOffline(false);
            await expect(page.getByTestId('freshnessBadge')).toHaveCount(0, { timeout: 15_000 });
        });
    });

    test('a choppy connection that fails every sync catches up on its own once requests get through again', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `liefi-choppy-${uniqueStamp()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Book the car service');
            await gtd.flush(page);

            const network = await dropApiRequests(page);
            const bootSyncGaveUp = page.waitForEvent('console', (message) => message.text().includes('[boot] load failed'));
            await page.goto(`${CLIENT_URL}/item/${item._id}`);
            await expect(page.getByTestId('itemPageWrapper')).toBeVisible({ timeout: LOCAL_RENDER_BUDGET_MS });
            await expect(page.getByTestId('freshnessBadge')).toHaveAttribute('data-freshness', 'unverified');

            // Recover only after the boot sync has given up: from then on the browser never went
            // offline and the live channel never reconnects, so only the catch-up retrier tries again.
            await bootSyncGaveUp;
            await network.recoverRequests();
            await expect(page.getByTestId('freshnessBadge')).toHaveCount(0, { timeout: 25_000 });
            await network.releaseChannels();
        });
    });
});
