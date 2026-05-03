import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Hard-refresh on a populated account used to flash the empty-state ("Inbox zero — well done.")
// for the frames between component mount and the IDB cache read completing. AppDataProvider now
// exposes `isInitialLoading`, gating the empty-state branch on each list page until the first
// IDB read resolves; routes render <PageLoadingSpinner /> while that flag is true.
//
// On a fast dev machine the spinner is too brief to assert visually without flake (the IDB read
// can resolve sub-frame). The contract this spec locks in instead: hard-refreshing a populated
// account renders items normally — verifying the loading guard hasn't broken the post-load state.
test.describe('initial loading state', () => {
    test('hard refresh on inbox renders items after the loading gate', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `loading-inbox-${dayjs().valueOf()}@example.com`, async (page) => {
            await gtd.collect(page, 'Process the morning mail');
            await gtd.flush(page);

            await page.reload();

            await expect(page.getByText('Process the morning mail')).toBeVisible();
            await expect(page.getByText('Inbox zero — well done.')).toHaveCount(0);
        });
    });

    test('cold navigation to next-actions renders items, never the empty-filters copy', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `loading-na-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Renew passport');
            await gtd.clarifyToNextAction(page, inbox, { energy: 'low', time: 5 });
            await gtd.flush(page);

            await page.goto('http://localhost:4173/next-actions');

            await expect(page.getByText('Renew passport')).toBeVisible();
            await expect(page.getByText('No next actions match the current filters.')).toHaveCount(0);
        });
    });
});
