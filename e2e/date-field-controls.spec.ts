import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import type { StoredItem } from '../client/src/types/MyDB';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Every date field in the app is the shared DateField: native <input type="date"> plus a Clear
// button (the mobile wheel pickers cannot empty a date once set) and a Pick button opening a
// quick-pick + month-grid popover (typing segment-by-segment on a laptop is slow; desktop Safari
// has no picker at all). Time fields get the same Clear button.

const ISO_DAY = 'YYYY-MM-DD';
// iPhone-sized touch context — the clear bug only ever bit on phones.
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

async function savedItem(page: Page, id: string): Promise<StoredItem> {
    const saved = (await gtd.listItems(page)).find((i) => i._id === id);
    if (!saved) throw new Error(`expected item ${id} in IDB`);
    return saved;
}

async function openItemPage(page: Page, itemId: string): Promise<void> {
    // Flush before goto — navigating mid-flush wedges the IDB sync-queue lock (~30s stall).
    await gtd.flush(page);
    await page.goto(`/item/${itemId}`);
    await expect(page.getByTestId('itemPageWrapper')).toBeVisible();
}

async function saveAndFlush(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Save changes' }).click();
    await gtd.flush(page);
}

test.describe('Date field controls', () => {
    test('phone: the Clear button empties Expected by and the save drops the date', async ({ browser }) => {
        await withOneLoggedInDevice(
            browser,
            `date-clear-phone-${dayjs().valueOf()}@example.com`,
            async (page) => {
                const captured = await gtd.collect(page, 'Renew passport');
                const expectedBy = dayjs().add(10, 'day').format(ISO_DAY);
                await gtd.clarifyToNextAction(page, captured, { expectedBy });
                await openItemPage(page, captured._id);

                // The field label must still resolve to exactly one element (the input) — the
                // buttons are named via `title`, which getByLabel ignores.
                await expect(page.getByLabel('Expected by')).toHaveValue(expectedBy);
                await page.getByRole('button', { name: 'Clear Expected by' }).click();
                await expect(page.getByLabel('Expected by')).toHaveValue('');
                // Nothing left to clear — the button must go away rather than sit there inert.
                await expect(page.getByRole('button', { name: 'Clear Expected by' })).toHaveCount(0);

                await saveAndFlush(page);
                expect((await savedItem(page, captured._id)).expectedBy).toBeUndefined();
            },
            PHONE,
        );
    });

    test('phone: the Clear button empties the tickler date on a next action', async ({ browser }) => {
        await withOneLoggedInDevice(
            browser,
            `date-clear-tickler-${dayjs().valueOf()}@example.com`,
            async (page) => {
                const captured = await gtd.collect(page, 'Snoozed chore');
                await gtd.clarifyToNextAction(page, captured, { ignoreBefore: dayjs().add(4, 'day').format(ISO_DAY) });
                await openItemPage(page, captured._id);

                // The tickler input has a caption instead of a floating label; accessibleName names it.
                await page.getByRole('button', { name: 'Clear Tickler date' }).click();
                await expect(page.getByLabel('Tickler date')).toHaveValue('');
                await saveAndFlush(page);
                expect((await savedItem(page, captured._id)).ignoreBefore).toBeUndefined();
            },
            PHONE,
        );
    });

    test('desktop: the picker sets a date by quick pick and by month grid', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `date-pick-desktop-${dayjs().valueOf()}@example.com`, async (page) => {
            const captured = await gtd.collect(page, 'Book dentist');
            await gtd.clarifyToNextAction(page, captured);
            await openItemPage(page, captured._id);

            // Quick pick: one click lands tomorrow and closes the popover.
            await page.getByRole('button', { name: 'Pick Expected by' }).click();
            await expect(page.getByTestId('datePickerPanel')).toBeVisible();
            await page.getByRole('button', { name: 'Tomorrow' }).click();
            await expect(page.getByTestId('datePickerPanel')).toHaveCount(0);
            const tomorrow = dayjs().add(1, 'day').format(ISO_DAY);
            await expect(page.getByLabel('Expected by')).toHaveValue(tomorrow);

            // Month grid: reopen (on tomorrow's month), page forward once, pick the 15th.
            await page.getByRole('button', { name: 'Pick Expected by' }).click();
            const panel = page.getByTestId('datePickerPanel');
            await expect(panel.getByTestId('datePickerMonth')).toHaveText(dayjs(tomorrow).format('MMMM YYYY'));
            await panel.getByRole('button', { name: 'Next month' }).click();
            const target = dayjs(tomorrow).add(1, 'month').date(15);
            await expect(panel.getByTestId('datePickerMonth')).toHaveText(target.format('MMMM YYYY'));
            await panel.getByRole('button', { name: target.format('dddd, MMMM D, YYYY') }).click();
            await expect(page.getByLabel('Expected by')).toHaveValue(target.format(ISO_DAY));

            await saveAndFlush(page);
            expect((await savedItem(page, captured._id)).expectedBy).toBe(target.format(ISO_DAY));
        });
    });

    test('desktop: reopening the picker returns to the month of the current value', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `date-pick-reseed-${dayjs().valueOf()}@example.com`, async (page) => {
            // Two months out so "value's month" and "today's month" cannot coincide.
            const twoMonthsOut = dayjs().add(2, 'month').date(10);
            const captured = await gtd.collect(page, 'Plan quarterly review');
            await gtd.clarifyToNextAction(page, captured, { expectedBy: twoMonthsOut.format(ISO_DAY) });
            await openItemPage(page, captured._id);

            await page.getByRole('button', { name: 'Pick Expected by' }).click();
            const panel = page.getByTestId('datePickerPanel');
            await expect(panel.getByTestId('datePickerMonth')).toHaveText(twoMonthsOut.format('MMMM YYYY'));
            await panel.getByRole('button', { name: 'Next month' }).click();
            await expect(panel.getByTestId('datePickerMonth')).toHaveText(twoMonthsOut.add(1, 'month').format('MMMM YYYY'));

            // Dismiss without picking: the paged month must not survive to the next open.
            await page.keyboard.press('Escape');
            await expect(panel).toHaveCount(0);
            await page.getByRole('button', { name: 'Pick Expected by' }).click();
            await expect(page.getByTestId('datePickerPanel').getByTestId('datePickerMonth')).toHaveText(twoMonthsOut.format('MMMM YYYY'));
        });
    });

    test('desktop: clearing from the keyboard keeps focus in the field; a pointer click leaves focus alone', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `date-clear-focus-${dayjs().valueOf()}@example.com`, async (page) => {
            const captured = await gtd.collect(page, 'Return library books');
            await gtd.clarifyToNextAction(page, captured, { expectedBy: dayjs().add(3, 'day').format(ISO_DAY) });
            await openItemPage(page, captured._id);

            // Keyboard: the Clear button unmounts under the user, so focus must move into the input.
            await page.getByRole('button', { name: 'Clear Expected by' }).focus();
            await page.keyboard.press('Enter');
            await expect(page.getByLabel('Expected by')).toHaveValue('');
            await expect(page.getByLabel('Expected by')).toBeFocused();

            // Pointer: refilling then clicking Clear must NOT focus the input — on iOS that focus
            // would open the native picker and could write a date straight back.
            await page.getByLabel('Expected by').fill(dayjs().add(5, 'day').format(ISO_DAY));
            await page.getByRole('button', { name: 'Clear Expected by' }).click();
            await expect(page.getByLabel('Expected by')).toHaveValue('');
            await expect(page.getByLabel('Expected by')).not.toBeFocused();
        });
    });

    test('desktop: typing into the native input still works alongside the picker', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `date-type-desktop-${dayjs().valueOf()}@example.com`, async (page) => {
            const captured = await gtd.collect(page, 'File taxes');
            await gtd.clarifyToNextAction(page, captured);
            await openItemPage(page, captured._id);

            const typed = dayjs().add(20, 'day').format(ISO_DAY);
            await page.getByLabel('Expected by').fill(typed);
            // Clear appears as soon as the typed value lands — the two entry paths share one state.
            await expect(page.getByRole('button', { name: 'Clear Expected by' })).toBeVisible();
            await saveAndFlush(page);
            expect((await savedItem(page, captured._id)).expectedBy).toBe(typed);
        });
    });

    test('phone: the Clear button empties a calendar end time and the save falls back to one hour', async ({ browser }) => {
        await withOneLoggedInDevice(
            browser,
            `time-clear-phone-${dayjs().valueOf()}@example.com`,
            async (page) => {
                const captured = await gtd.collect(page, 'Team standup');
                const start = dayjs().add(1, 'day').hour(9).minute(0).second(0).millisecond(0);
                await gtd.clarifyToCalendar(page, captured, { timeStart: start.toISOString(), timeEnd: start.add(30, 'minute').toISOString() });
                await openItemPage(page, captured._id);

                await expect(page.getByLabel('End time')).toHaveValue('09:30');
                await page.getByRole('button', { name: 'Clear End time' }).click();
                await expect(page.getByLabel('End time')).toHaveValue('');
                await expect(page.getByRole('button', { name: 'Clear End time' })).toHaveCount(0);

                await saveAndFlush(page);
                expect((await savedItem(page, captured._id)).timeEnd).toBe(start.add(1, 'hour').toISOString());
            },
            PHONE,
        );
    });

    test('clearing the required calendar Date disables Save instead of silently saving "now"', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `date-clear-required-${dayjs().valueOf()}@example.com`, async (page) => {
            const captured = await gtd.collect(page, 'Dentist appointment');
            const start = dayjs().add(2, 'day').hour(14).minute(0).second(0).millisecond(0);
            await gtd.clarifyToCalendar(page, captured, { timeStart: start.toISOString(), timeEnd: start.add(1, 'hour').toISOString() });
            await openItemPage(page, captured._id);

            await expect(page.getByLabel('Date')).toHaveValue(start.format(ISO_DAY));
            await expect(page.getByRole('button', { name: 'Save changes' })).toBeEnabled();
            await page.getByRole('button', { name: 'Clear Date' }).click();
            await expect(page.getByLabel('Date')).toHaveValue('');
            await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
        });
    });
});
