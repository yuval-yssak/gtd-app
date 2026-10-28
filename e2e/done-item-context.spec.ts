import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

// A done item says what it was before completion: its prior status plus the fields that mattered
// there — a calendar event's start/end, whom a waiting-for waited on, a next action's contexts.

/** Yesterday 14:00–15:30 local — in the past, so marking it done never asks the future-done confirm. */
const eventStart = dayjs().subtract(1, 'day').hour(14).minute(0).second(0).millisecond(0);
const eventEnd = eventStart.add(90, 'minute');
const expectedWhen = `${eventStart.format('ddd, MMM D')} · 2:00 pm – 3:30 pm`;

const doneRow = (page: Page, title: string) => page.getByRole('link', { name: new RegExp(title) });

async function seedPastCalendarItem(page: Page, title: string) {
    const item = await gtd.collect(page, title);
    return gtd.clarifyToCalendar(page, item, { timeStart: eventStart.format('YYYY-MM-DDTHH:mm:ss'), timeEnd: eventEnd.format('YYYY-MM-DDTHH:mm:ss') });
}

test.describe('Done items show what they were', () => {
    test('the Done list and the item page show the prior status with its key fields', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `done-context-${uniqueStamp()}@example.com`, async (page) => {
            const dana = await gtd.createPerson(page, { name: 'Dana' });
            const phone = await gtd.createWorkContext(page, 'Phone');
            await gtd.clarifyToDone(page, await seedPastCalendarItem(page, 'Dentist'));
            const waiting = await gtd.collect(page, 'Signed lease');
            await gtd.clarifyToDone(page, await gtd.clarifyToWaitingFor(page, waiting, { waitingForPersonId: dana._id }));
            const call = await gtd.collect(page, 'Call the bank');
            await gtd.clarifyToDone(
                page,
                await gtd.clarifyToNextAction(page, call, { workContextIds: [phone._id], peopleIds: [dana._id], energy: 'low', time: 10 }),
            );
            await gtd.flush(page); // never navigate mid-flush — see CLAUDE.md § E2E

            await page.goto('/done');
            await expect(doneRow(page, 'Dentist').getByTestId('doneItemContextSummary')).toHaveText(`Calendar · ${expectedWhen}`);
            await expect(doneRow(page, 'Signed lease').getByTestId('doneItemContextSummary')).toHaveText('Waiting For · Dana');
            await expect(doneRow(page, 'Call the bank').getByTestId('doneItemContextSummary')).toHaveText('Next Action · Phone · Dana');

            // The item page lists every kept field, read-only, under "Before it was done".
            await doneRow(page, 'Dentist').click();
            const section = page.getByTestId('doneItemContext');
            await expect(section.getByRole('heading', { name: 'Before it was done' })).toBeVisible();
            await expect(section.getByTestId('doneItemContextStatus')).toHaveText('Calendar');
            await expect(section.getByTestId('doneItemContextFact').filter({ hasText: 'When' })).toContainText(expectedWhen);

            // The server recorded the same prior status for every one of them.
            const { items } = await gtd.fetchBootstrap(page);
            const statusBeforeDone = Object.fromEntries(items.map((item) => [item.title, item.statusBeforeDone]));
            expect(statusBeforeDone).toMatchObject({ Dentist: 'calendar', 'Signed lease': 'waitingFor', 'Call the bank': 'nextAction' });
        });
    });

    test('marking a calendar event done in the editor shows its start and end in place of the calendar fields', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `done-context-editor-${uniqueStamp()}@example.com`, async (page) => {
            const event = await seedPastCalendarItem(page, 'Team offsite');
            await gtd.flush(page); // never navigate mid-flush — see CLAUDE.md § E2E

            await page.goto(`/item/${event._id}`);
            const editor = page.getByTestId('itemPageWrapper');
            // Not done yet: no "before" section on a live calendar item.
            await expect(editor.getByTestId('doneItemContext')).toHaveCount(0);
            await editor
                .getByTestId('itemEditorStatusChip')
                .and(page.getByRole('button', { name: 'Done', exact: true }))
                .click();
            await editor.getByRole('button', { name: 'Save changes' }).click();
            await expect(editor).toBeHidden();
            await gtd.flush(page);
            await page.goto('/done');

            await expect(doneRow(page, 'Team offsite').getByTestId('doneItemContextSummary')).toHaveText(`Calendar · ${expectedWhen}`);
            await doneRow(page, 'Team offsite').click();
            await expect(page.getByTestId('doneItemContextFact').filter({ hasText: 'When' })).toContainText(expectedWhen);
            // Picking another status swaps the read-only section for that status's own fields.
            await page
                .getByTestId('itemEditorStatusChip')
                .and(page.getByRole('button', { name: 'Next Action', exact: true }))
                .click();
            await expect(page.getByTestId('doneItemContext')).toHaveCount(0);
        });
    });
});
