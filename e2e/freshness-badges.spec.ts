import { expect, type Page, test } from '@playwright/test';
import { withOneLoggedInDevice } from './helpers/context';
import { CLIENT_URL } from './helpers/env';
import { gtd } from './helpers/gtd';
import { hangApi } from './helpers/networkConditions';
import { uniqueStamp } from './helpers/uniqueStamp';

/** The shrunk long-absence threshold for these specs, set through the harness. */
const LONG_AWAY_MS = 2_000;

/**
 * Drives the page through hidden → (real time passes) → visible, the way a backgrounded PWA returns.
 * The API hangs from the moment of return, so the resume sync cannot re-verify the data behind the
 * assertion's back. Real waiting, not a fake clock: page.clock stalls the app's own timers.
 */
async function returnAfter(page: Page, absenceMs: number) {
    await setVisibility(page, 'hidden');
    await page.waitForTimeout(absenceMs);
    const network = await hangApi(page);
    await setVisibility(page, 'visible');
    return network;
}

/** A device freshly checked with the server: the harness pull marks every account verified. */
async function openVerified(page: Page, itemId: string) {
    await page.goto(`${CLIENT_URL}/item/${itemId}`);
    await expect(page.getByTestId('itemPageWrapper')).toBeVisible();
    await gtd.setLongAwayMs(page, LONG_AWAY_MS);
    await gtd.pull(page);
    await expect(page.getByTestId('statusBarAwaitingServer')).toHaveCount(0);
    await expect(page.getByTestId('freshnessBadge')).toHaveCount(0);
}

function setVisibility(page: Page, state: 'hidden' | 'visible') {
    return page.evaluate((visibility) => {
        Object.defineProperty(document, 'visibilityState', { value: visibility, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
    }, state);
}

test.describe('freshness badge on routine, person and work-context pages', () => {
    test('each detail page says when its copy has not been checked with the server', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `badges-${uniqueStamp()}@example.com`, async (page) => {
            const routine = await gtd.createRoutine(page, {
                title: 'Water plants',
                routineType: 'nextAction',
                rrule: 'FREQ=DAILY',
                template: {},
                active: true,
            });
            const person = await gtd.createPerson(page, { name: 'Dana' });
            const workContext = await gtd.createWorkContext(page, 'At the desk');
            await gtd.flush(page);

            const network = await hangApi(page);
            for (const path of [`/routine/${routine._id}`, `/person/${person._id}`, `/work-context/${workContext._id}`]) {
                await page.goto(`${CLIENT_URL}${path}`);
                await expect(page.getByTestId('freshnessBadge')).toHaveAttribute('data-freshness', 'unverified');
            }

            await network.release();
            await expect(page.getByTestId('freshnessBadge')).toHaveCount(0, { timeout: 15_000 });
        });
    });

    test('a person edited offline is marked "Not synced" until its push lands', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `badges-person-${uniqueStamp()}@example.com`, async (page) => {
            const person = await gtd.createPerson(page, { name: 'Dana' });
            await gtd.flush(page);
            await page.goto(`${CLIENT_URL}/person/${person._id}`);
            await expect(page.getByTestId('personPageWrapper')).toBeVisible();
            await expect(page.getByTestId('freshnessBadge')).toHaveCount(0);

            await page.context().setOffline(true);
            await page.getByRole('textbox', { name: 'Name' }).fill('Dana Cohen');
            await expect(page.getByTestId('freshnessBadge')).toHaveAttribute('data-freshness', 'unsynced');

            await page.context().setOffline(false);
            await expect(page.getByTestId('freshnessBadge')).toHaveCount(0, { timeout: 15_000 });
        });
    });
});

test.describe('freshness after the app returns from the background', () => {
    test('a long absence marks the data "Not verified" until the resume sync lands', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `resume-long-${uniqueStamp()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Call the bank');
            await gtd.flush(page);
            await openVerified(page, item._id);

            const network = await returnAfter(page, LONG_AWAY_MS + 500);
            await expect(page.getByTestId('freshnessBadge')).toHaveAttribute('data-freshness', 'unverified');

            await network.release();
            await expect(page.getByTestId('freshnessBadge')).toHaveCount(0, { timeout: 15_000 });
        });
    });

    test('a quick switch away keeps the data verified — the badge does not blink on every return', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `resume-short-${uniqueStamp()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Call the bank');
            await gtd.flush(page);
            await openVerified(page, item._id);

            const network = await returnAfter(page, LONG_AWAY_MS / 4);
            // Past the badge's fade-in delay, so a wrongly raised badge would be in the page by now.
            await page.waitForTimeout(1_500);
            await expect(page.getByTestId('freshnessBadge')).toHaveCount(0);
            await network.release();
        });
    });
});
