import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import type { StoredItem } from '../client/src/types/MyDB';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// A waitingFor item can be snoozed (ignoreBefore) — it lives on /tickler until that day. The editor
// used to hide the "Ignore before" field for waitingFor and seed it empty, so the date was invisible
// and any save silently dropped it, bouncing the item back onto /waiting-for.

async function savedItem(page: Page, id: string): Promise<StoredItem> {
    const saved = (await gtd.listItems(page)).find((i) => i._id === id);
    if (!saved) throw new Error(`expected item ${id} in IDB`);
    return saved;
}

test.describe('WaitingFor tickler date in the editor', () => {
    test('shows a snoozed waiting item’s Ignore before date and keeps it across a save', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wf-tickler-keep-${dayjs().valueOf()}@example.com`, async (page) => {
            const snoozeUntil = dayjs().add(3, 'day').format('YYYY-MM-DD');
            const person = await gtd.createPerson(page, { name: 'Victor' });
            const captured = await gtd.collect(page, 'Victor: remove leftovers');
            await gtd.clarifyToWaitingFor(page, captured, { waitingForPersonId: person._id, ignoreBefore: snoozeUntil });
            // An un-snoozed control row proves /waiting-for has rendered before the negative check.
            const control = await gtd.collect(page, 'Victor: approve budget');
            await gtd.clarifyToWaitingFor(page, control, { waitingForPersonId: person._id });
            // Flush before goto — navigating mid-flush wedges the IDB sync-queue lock (~30s stall).
            await gtd.flush(page);

            await page.goto(`/item/${captured._id}`);
            await expect(page.getByTestId('itemPageWrapper')).toBeVisible();
            await expect(page.getByLabel('Ignore before')).toHaveValue(snoozeUntil);

            await page.getByRole('textbox', { name: 'Title' }).fill('Victor: remove prod leftovers');
            await page.getByRole('button', { name: 'Save changes' }).click();
            await gtd.flush(page);

            const saved = await savedItem(page, captured._id);
            expect(saved.title).toBe('Victor: remove prod leftovers');
            expect(saved.ignoreBefore).toBe(snoozeUntil);

            await page.goto('/tickler');
            await expect(page.getByText('Victor: remove prod leftovers')).toBeVisible();
            await page.goto('/waiting-for');
            await expect(page.getByText('Victor: approve budget')).toBeVisible();
            await expect(page.getByText('Victor: remove prod leftovers')).toHaveCount(0);
        });
    });

    test('clearing Ignore before in the editor returns the item to /waiting-for', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `wf-tickler-clear-${dayjs().valueOf()}@example.com`, async (page) => {
            const person = await gtd.createPerson(page, { name: 'Dana' });
            const captured = await gtd.collect(page, 'Dana: send contract');
            await gtd.clarifyToWaitingFor(page, captured, { waitingForPersonId: person._id, ignoreBefore: dayjs().add(5, 'day').format('YYYY-MM-DD') });
            await gtd.flush(page);

            await page.goto(`/item/${captured._id}`);
            await page.getByLabel('Ignore before').fill('');
            await page.getByRole('button', { name: 'Save changes' }).click();
            await gtd.flush(page);

            expect((await savedItem(page, captured._id)).ignoreBefore).toBeUndefined();
            await page.goto('/waiting-for');
            await expect(page.getByText('Dana: send contract')).toBeVisible();
        });
    });
});
