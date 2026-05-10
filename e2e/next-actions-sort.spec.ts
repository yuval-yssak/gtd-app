import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// /next-actions sorts by focus desc first, then expectedBy desc. Within each focus group, items
// without an expectedBy fall to the bottom of that group (so they can't beat a dated row).
test.describe('Next actions list — sort order', () => {
    test('focus desc, then expectedBy desc; no-expectedBy rows fall to the bottom of their focus group', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `na-sort-${dayjs().valueOf()}@example.com`, async (page) => {
            const baseDate = '2026-06-01';

            // Seed four next-actions with distinct (focus, expectedBy) combos so we can pin order.
            const earlyFocus = await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Early focus'), {
                expectedBy: dayjs(baseDate).format('YYYY-MM-DD'),
                focus: true,
            });
            const noDateFocus = await gtd.clarifyToNextAction(page, await gtd.collect(page, 'No-date focus'), {
                focus: true,
            });
            const lateNoFocus = await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Late plain'), {
                expectedBy: dayjs(baseDate).add(30, 'day').format('YYYY-MM-DD'),
            });
            const earlyNoFocus = await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Early plain'), {
                expectedBy: dayjs(baseDate).format('YYYY-MM-DD'),
            });

            await page.goto('/next-actions');
            await page.waitForSelector('text=Early focus');

            // Expected order:
            //   Focus group (desc by expectedBy, no-date at bottom): Early focus, No-date focus
            //   Non-focus group (same rule):                          Late plain, Early plain
            const visibleTitles = await page.getByTestId('nextActionItemRow').allInnerTexts();
            const titles = visibleTitles.map((t) => t.split('\n')[0]?.trim() ?? '');
            expect(titles).toEqual(['Early focus', 'No-date focus', 'Late plain', 'Early plain']);

            // Sanity: every item was seeded with status nextAction and persisted as expected.
            const items = await gtd.listItems(page);
            for (const seeded of [earlyFocus, noDateFocus, lateNoFocus, earlyNoFocus]) {
                const got = items.find((i) => i._id === seeded._id);
                expect(got?.status).toBe('nextAction');
            }
        });
    });
});
