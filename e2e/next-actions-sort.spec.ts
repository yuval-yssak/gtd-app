import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// /next-actions sorts into four tiers, with ascending expectedBy as the inner order:
//   1. focused + has expectedBy   (asc by date)
//   2. focused + no expectedBy
//   3. not focused + has expectedBy (asc by date)
//   4. not focused + no expectedBy
test.describe('Next actions list — sort order', () => {
    test('focused-with-date asc, focused-no-date, other-with-date asc, other-no-date', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `na-sort-${dayjs().valueOf()}@example.com`, async (page) => {
            const baseDate = '2026-06-01';

            // Seed six items spanning all four tiers (two with dates per focus group so we can also
            // pin the ascending inner order).
            const earlyFocus = await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Early focus'), {
                expectedBy: dayjs(baseDate).format('YYYY-MM-DD'),
                focus: true,
            });
            const lateFocus = await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Late focus'), {
                expectedBy: dayjs(baseDate).add(30, 'day').format('YYYY-MM-DD'),
                focus: true,
            });
            const noDateFocus = await gtd.clarifyToNextAction(page, await gtd.collect(page, 'No-date focus'), {
                focus: true,
            });
            const earlyPlain = await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Early plain'), {
                expectedBy: dayjs(baseDate).format('YYYY-MM-DD'),
            });
            const latePlain = await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Late plain'), {
                expectedBy: dayjs(baseDate).add(30, 'day').format('YYYY-MM-DD'),
            });
            const noDatePlain = await gtd.clarifyToNextAction(page, await gtd.collect(page, 'No-date plain'), {});

            await page.goto('/next-actions');
            await page.waitForSelector('text=Early focus');

            const visibleTitles = await page.getByTestId('nextActionItemRow').allInnerTexts();
            const titles = visibleTitles.map((t) => t.split('\n')[0]?.trim() ?? '');
            expect(titles).toEqual([
                'Early focus', // tier 1: focused + date, earliest
                'Late focus', // tier 1: focused + date, later
                'No-date focus', // tier 2: focused, no date
                'Early plain', // tier 3: plain + date, earliest
                'Late plain', // tier 3: plain + date, later
                'No-date plain', // tier 4: plain, no date
            ]);

            // Sanity: every item was seeded with status nextAction.
            const items = await gtd.listItems(page);
            for (const seeded of [earlyFocus, lateFocus, noDateFocus, earlyPlain, latePlain, noDatePlain]) {
                const got = items.find((i) => i._id === seeded._id);
                expect(got?.status).toBe('nextAction');
            }
        });
    });
});
