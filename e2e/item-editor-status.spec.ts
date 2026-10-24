import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

// Tests the unified item editor: status-aware editor with chip-based status switching.
// Each test drives the UI (clicks, form inputs) rather than calling __gtd directly so we
// cover the editor's wiring in addition to the underlying mutations.

test.describe('Item editor — unified status editor', () => {
    test('edit inbox item title and notes in place', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `edit-inbox-${uniqueStamp()}@example.com`, async (page) => {
            await gtd.collect(page, 'Original inbox title');
            await page.goto('/inbox');
            await page.waitForSelector('text=Original inbox title');

            // Inbox rows render an Edit icon button as the first action (tooltip: "Edit").
            await page.getByRole('button', { name: 'Edit' }).first().click();
            const editor = page.getByTestId('itemPageWrapper');
            await expect(editor).toBeVisible();

            // Only the selected status chip takes a colour: an inbox item's Done and Trash stay neutral.
            const statusChip = (label: string) => editor.getByTestId('itemEditorStatusChip').and(page.getByRole('button', { name: label, exact: true }));
            await expect(statusChip('Inbox')).toHaveAttribute('aria-pressed', 'true');
            await expect(statusChip('Done')).toHaveAttribute('data-tone', 'neutral');
            await expect(statusChip('Trash')).toHaveAttribute('data-tone', 'neutral');

            await editor.getByLabel('Title').fill('Revised inbox title');
            await editor.getByLabel('Notes (Markdown)').fill('**bold** note body');
            await editor.getByRole('button', { name: 'Save changes' }).click();
            await expect(editor).toBeHidden();

            await gtd.flush(page);
            const items = await gtd.listItems(page);
            const updated = items.find((i) => i.title === 'Revised inbox title');
            expect(updated).toBeDefined();
            expect(updated?.notes).toBe('**bold** note body');
            expect(updated?.status).toBe('inbox');
        });
    });

    test('switch status from inbox to next-action via status chip', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `edit-to-na-${uniqueStamp()}@example.com`, async (page) => {
            await gtd.collect(page, 'Something actionable');
            await page.goto('/inbox');
            await page.waitForSelector('text=Something actionable');

            await page.getByRole('button', { name: 'Edit' }).first().click();
            const editor = page.getByTestId('itemPageWrapper');

            // The Next Action chip appears in the Status section.
            await editor.getByRole('button', { name: 'Next Action' }).click();
            // Next-action fields should now be visible (Energy / Time / etc).
            await expect(editor.getByText('Energy', { exact: false })).toBeVisible();

            await editor.getByRole('button', { name: 'Save changes' }).click();
            await expect(editor).toBeHidden();

            await gtd.flush(page);
            const items = await gtd.listItems(page);
            const updated = items.find((i) => i.title === 'Something actionable');
            expect(updated?.status).toBe('nextAction');
        });
    });

    test('switch status from inbox to someday/maybe via status chip', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `edit-to-someday-${uniqueStamp()}@example.com`, async (page) => {
            await gtd.collect(page, 'Parking lot idea');
            await page.goto('/inbox');
            await page.waitForSelector('text=Parking lot idea');

            await page.getByRole('button', { name: 'Edit' }).first().click();
            const editor = page.getByTestId('itemPageWrapper');

            await editor.getByRole('button', { name: 'Someday / Maybe' }).click();
            // Someday/Maybe has no specific fields beyond title/notes — just the placeholder copy.
            await expect(editor.getByText('Parked for later review', { exact: false })).toBeVisible();

            await editor.getByRole('button', { name: 'Save changes' }).click();
            await expect(editor).toBeHidden();

            await gtd.flush(page);
            const items = await gtd.listItems(page);
            const updated = items.find((i) => i.title === 'Parking lot idea');
            expect(updated?.status).toBe('somedayMaybe');

            // Verify someday route lists it.
            await page.goto('/someday');
            await expect(page.getByText('Parking lot idea')).toBeVisible();
        });
    });

    test('detach routine-generated calendar item when moved to next-action via the editor', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `edit-detach-${uniqueStamp()}@example.com`, async (page) => {
            // Seed a calendar routine + an item carrying routineId as if generated by that routine.
            const routine = await gtd.createRoutine(page, {
                title: 'Weekly team sync',
                routineType: 'calendar',
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                template: {},
                calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
                active: true,
            });
            const inbox = await gtd.collect(page, 'Editor-detach target');
            const calItem = await gtd.clarifyToCalendar(page, inbox, {
                timeStart: dayjs().add(7, 'day').hour(9).minute(0).second(0).millisecond(0).toISOString(),
                timeEnd: dayjs().add(7, 'day').hour(9).minute(30).second(0).millisecond(0).toISOString(),
            });
            const withRoutine = await gtd.updateItem(page, { ...calItem, routineId: routine._id });
            expect(withRoutine.routineId).toBe(routine._id);

            // Drive the editor: click Edit on the calendar row, switch status to Next Action, save.
            await page.goto('/calendar');
            await page.waitForSelector('text=Editor-detach target');
            await page.getByRole('button', { name: 'Edit' }).first().click();
            const editor = page.getByTestId('itemPageWrapper');
            await editor.getByRole('button', { name: 'Next Action' }).click();
            await editor.getByRole('button', { name: 'Save changes' }).click();
            await expect(editor).toBeHidden();

            // After the editor's shouldDetach path, the persisted item should have no routineId.
            const items = await gtd.listItems(page);
            const updated = items.find((i) => i._id === withRoutine._id);
            expect(updated?.status).toBe('nextAction');
            expect(updated?.routineId).toBeUndefined();
        });
    });
});
