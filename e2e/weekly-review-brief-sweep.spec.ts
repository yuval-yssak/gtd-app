import { expect, type Page, type Request, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

/**
 * Review-start brief sweep (`docs/plans/item-brief.md` § 3.1, open decision 5): opening the
 * Weekly Review fires `POST /maintenance/briefs/sweep-mine` ONCE, fire-and-forget, so items whose
 * title + notes checksum moved get fresh briefs while the user walks the review.
 *
 * The assertions are about the REQUEST, not about model output: the generated briefs land later as
 * ordinary `itemBrief` sync ops, and waiting on that timing would make the spec flaky. (The
 * generation itself is covered by `item-brief-generate.spec.ts` and the server unit suite.)
 */

const SWEEP_GLOB = '**/maintenance/briefs/sweep-mine';

/** Records every sweep request the page issues, letting each one through untouched. */
async function recordSweepRequests(page: Page): Promise<Request[]> {
    const requests: Request[] = [];
    await page.route(SWEEP_GLOB, async (route) => {
        requests.push(route.request());
        await route.fallback();
    });
    return requests;
}

async function startReview(page: Page): Promise<void> {
    await page.goto('/weekly-review?stage=nextActions');
    await page.getByTestId('startReviewButton').click();
    await expect(page.getByTestId('reviewStageTitle')).toHaveText('Next Actions');
}

test.describe('weekly review — brief sweep on start', () => {
    test('opening the review fires exactly one sweep-mine POST, and walking the review fires no more', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-sweep-${dayjs().valueOf()}@example.com`, async (page) => {
            const captured = await gtd.collect(page, 'Renew passport');
            await gtd.clarifyToNextAction(page, { ...captured, notes: 'Short notes so the sweep writes a skip row.' }, {});
            const second = await gtd.collect(page, 'Book the dentist');
            await gtd.clarifyToNextAction(page, { ...second, notes: 'Also short.' }, {});
            await gtd.flush(page); // never navigate mid-flush — see clarify-to-routine.spec.ts

            const sweeps = await recordSweepRequests(page);
            await startReview(page);

            // One request, POST, no body — the route takes the caller from the session cookie.
            await expect.poll(() => sweeps.length).toBe(1);
            const [sweep] = sweeps;
            if (!sweep) throw new Error('expected one sweep request');
            expect(sweep.method()).toBe('POST');
            expect(sweep.postData()).toBeNull();
            // Let through untouched, so a malformed request (no session cookie, rejected shape)
            // would fail here instead of passing as "one request was made".
            const response = await sweep.response();
            expect(response?.status()).toBe(200);
            expect(await response?.json()).toMatchObject({ cooldown: false });

            // Walking the review remounts stages and re-runs the wizard's effects; the module-level
            // guard keyed on account + flow.startedTs holds it to the one request.
            await page.getByTestId('reviewHeaderStrip').click(); // "Skip stage" lives in the expanded header
            await page.getByTestId('skipStageButton').click();
            await expect(page.getByTestId('reviewStageTitle').first()).not.toHaveText('Next Actions');
            await page.waitForTimeout(500);
            expect(sweeps).toHaveLength(1);
        });
    });

    test('the sweep briefs the open items and never the done or trashed ones', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-sweep-scope-${dayjs().valueOf()}@example.com`, async (page) => {
            // Long enough to reach the (fake) model rather than the short-notes skip rule.
            const notes =
                'Renewal form is half filled in — the personal details section is done but the travel history page is still blank. ' +
                'Two new photos are needed, and the June trip is the hard deadline given four-to-six week processing.';
            const open = await gtd.collect(page, 'Renew passport');
            await gtd.clarifyToNextAction(page, { ...open, notes }, {});
            const done = await gtd.collect(page, 'Already finished');
            await gtd.updateItem(page, { ...done, notes, status: 'done' });
            const trashed = await gtd.collect(page, 'Thrown away');
            await gtd.updateItem(page, { ...trashed, notes, status: 'trash' });
            await gtd.flush(page); // never navigate mid-flush — see clarify-to-routine.spec.ts

            await startReview(page);

            // The open item gets a model brief; the closed two are never even considered, so no
            // row of any kind appears for them — not a brief, not a skip marker.
            await expect.poll(async () => (await gtd.getItemBrief(page, open._id))?.origin, { timeout: 20_000 }).toBe('model');
            expect(await gtd.getItemBrief(page, done._id)).toBeUndefined();
            expect(await gtd.getItemBrief(page, trashed._id)).toBeUndefined();
        });
    });

    test('the wizard opens and stays usable when the sweep request fails', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-sweep-fail-${dayjs().valueOf()}@example.com`, async (page) => {
            const captured = await gtd.collect(page, 'Renew passport');
            const item = await gtd.clarifyToNextAction(page, { ...captured, notes: 'Notes that will never be swept.' }, {});
            await gtd.flush(page);

            // Kill the advisory call outright: it must never reach the user.
            let abortedCount = 0;
            await page.route(SWEEP_GLOB, async (route) => {
                abortedCount += 1;
                await route.abort('failed');
            });

            await startReview(page);
            const card = page.getByTestId('focusStage');
            await expect(card.getByRole('textbox', { name: 'Title' })).toHaveValue('Renew passport');
            await expect.poll(() => abortedCount).toBe(1);

            // Nothing about the failure surfaces, and the card still edits + persists.
            await expect(page.getByRole('alert')).toHaveCount(0);
            const titleInput = card.getByRole('textbox', { name: 'Title' });
            await titleInput.fill('Renew passport this week');
            await card.getByTestId('briefField').getByRole('textbox', { name: 'Brief' }).click();
            await expect.poll(async () => (await gtd.listItems(page)).find((row) => row._id === item._id)?.title).toBe('Renew passport this week');
        });
    });
    test('a review opened offline issues no sweep, and sweeps once connectivity returns', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wr-sweep-offline-${dayjs().valueOf()}@example.com`, async (page) => {
            const captured = await gtd.collect(page, 'Renew passport');
            await gtd.clarifyToNextAction(page, { ...captured, notes: 'Short notes, offline review.' }, {});
            await gtd.flush(page);

            const sweeps = await recordSweepRequests(page);
            await page.goto('/weekly-review?stage=nextActions');
            await page.context().setOffline(true);
            await page.getByTestId('startReviewButton').click();
            await expect(page.getByTestId('reviewStageTitle')).toHaveText('Next Actions');

            // Offline the sweep is skipped OUTRIGHT — pinning the session is itself a network call,
            // so deciding inside the HTTP wrapper would be too late (see reviewBriefSweep.ts).
            await page.waitForTimeout(500);
            expect(sweeps).toHaveLength(0);

            // Coming back online sweeps THIS run: the offline attempt must not have burned it.
            await page.context().setOffline(false);
            await expect.poll(() => sweeps.length, { timeout: 15_000 }).toBe(1);
        });
    });
});
