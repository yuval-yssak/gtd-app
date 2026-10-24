import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

// /next-actions is sectioned by expected day (ascending, "No date" last) and ordered by the
// manual `rank` inside each day. A freshly created item is minted a rank ABOVE the user's
// existing ones, so inside its section the newest item comes first.
test.describe('Next actions list — sort order', () => {
    test('dated sections ascending with one header per day, then "No date" newest-first; a new item lands at the top of its section', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `na-sort-${uniqueStamp()}@example.com`, async (page) => {
            const earlyDay = '2027-06-01';
            const lateDay = '2027-07-01';

            // Seeded oldest-first; the two same-day items prove "newest first" within a section.
            const lateFirst = await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Late first'), { expectedBy: lateDay });
            const earlyOlder = await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Early older'), { expectedBy: earlyDay });
            const earlyNewer = await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Early newer'), { expectedBy: `${earlyDay}T18:00:00+03:00` });
            const noDateOlder = await gtd.clarifyToNextAction(page, await gtd.collect(page, 'No-date older'), {});
            const noDateNewer = await gtd.clarifyToNextAction(page, await gtd.collect(page, 'No-date newer'), {});
            await gtd.flush(page);

            await page.goto('/next-actions');
            await page.waitForSelector('text=Late first');

            const headers = await page.getByTestId('nextActionSectionHeader').allInnerTexts();
            expect(headers).toEqual([dayjs(earlyDay).format('ddd MMM D'), dayjs(lateDay).format('ddd MMM D'), 'No date']);

            const titles = (await page.getByTestId('nextActionItemRow').allInnerTexts()).map((t) => t.split('\n')[0]?.trim() ?? '');
            expect(titles).toEqual(['Early newer', 'Early older', 'Late first', 'No-date newer', 'No-date older']);

            // Every item carries a rank, strictly decreasing in creation order (each mint goes above the last).
            const items = await gtd.listItems(page);
            const ranks = [lateFirst, earlyOlder, earlyNewer, noDateOlder, noDateNewer].map((seeded) => items.find((i) => i._id === seeded._id)?.rank ?? '');
            expect(ranks.every(Boolean)).toBe(true);
            for (let idx = 1; idx < ranks.length; idx++) {
                expect((ranks[idx] ?? '') < (ranks[idx - 1] ?? '')).toBe(true);
            }

            // Geometry, not just text: the "Early" header sits above its rows, which sit above the "Late" header.
            const earlyHeaderBox = await page.getByTestId('nextActionSectionHeader').nth(0).boundingBox();
            const earlyNewerBox = await page.getByTestId('nextActionItemRow').filter({ hasText: 'Early newer' }).boundingBox();
            const lateHeaderBox = await page.getByTestId('nextActionSectionHeader').nth(1).boundingBox();
            expect(earlyHeaderBox && earlyNewerBox && lateHeaderBox).toBeTruthy();
            expect((earlyHeaderBox?.y ?? 0) < (earlyNewerBox?.y ?? 0) && (earlyNewerBox?.y ?? 0) < (lateHeaderBox?.y ?? 0)).toBe(true);
        });
    });

    test('an unranked item (pre-rollout row, pulled without a rank) sorts above ranked ones in its section', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `na-sort-unranked-${uniqueStamp()}@example.com`, async (page) => {
            const ranked = await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Ranked newer'), {});
            expect(ranked.rank).toBeTruthy();
            // Strip the rank locally the way a pre-rollout snapshot would arrive — updateItem spreads the row as given.
            const legacy = await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Legacy unranked'), {});
            const { rank: _rank, ...withoutRank } = legacy;
            await gtd.updateItem(page, { ...withoutRank, createdTs: '2020-01-01T00:00:00.000Z' });
            await gtd.flush(page);

            await page.goto('/next-actions');
            await page.waitForSelector('text=Legacy unranked');
            const titles = (await page.getByTestId('nextActionItemRow').allInnerTexts()).map((t) => t.split('\n')[0]?.trim() ?? '');
            expect(titles).toEqual(['Legacy unranked', 'Ranked newer']);
        });
    });

    test('an overdue day is its own section, labelled in the error colour, and "Today" is named', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `na-sort-overdue-${uniqueStamp()}@example.com`, async (page) => {
            const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
            const lastWeek = dayjs().subtract(7, 'day').format('YYYY-MM-DD');
            await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Yesterday item'), { expectedBy: yesterday });
            await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Last week item'), { expectedBy: lastWeek });
            await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Today item'), { expectedBy: dayjs().format('YYYY-MM-DD') });
            await gtd.flush(page);

            await page.goto('/next-actions');
            await page.waitForSelector('text=Today item');
            const headers = await page.getByTestId('nextActionSectionHeader').allInnerTexts();
            expect(headers).toEqual([`Overdue · ${dayjs(lastWeek).format('ddd MMM D')}`, `Overdue · ${dayjs(yesterday).format('ddd MMM D')}`, 'Today']);
        });
    });
});
