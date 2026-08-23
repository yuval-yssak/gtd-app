import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Clarify-to-routine: the item editor's Routine status chip converts an inbox item into a
// recurring routine — the item is consumed (trashed) and the routine seeds its first item.
// Driven through the UI so the chip visibility, embedded routine form, save path, and undo
// snackbar wiring are all covered in addition to the underlying mutations.

test.describe('clarify inbox item to routine', () => {
    test('Routine chip converts the item: routine created, item trashed, first item seeded', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `clar-routine-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Water the plants');
            // Drain the capture's fire-and-forget flush BEFORE navigating — a goto mid-flush
            // destroys the JS context while it holds the cross-context flush lock (30s TTL),
            // silently no-opping every later flush in this test.
            await gtd.flush(page);
            await page.goto('/inbox');
            await page.waitForSelector('text=Water the plants');

            await page.getByRole('button', { name: 'Edit' }).first().click();
            const dialog = page.getByRole('dialog', { name: 'Edit item' });
            await expect(dialog).toBeVisible();

            await dialog.getByRole('button', { name: 'Routine' }).click();
            // The embedded routine form appears (type toggle + frequency + template sections).
            await expect(dialog.getByTestId('itemEditorRoutineFields')).toBeVisible();
            await expect(dialog.getByText('Frequency')).toBeVisible();

            await dialog.getByRole('button', { name: 'Save changes' }).click();
            await expect(dialog).toBeHidden();

            await gtd.flush(page);
            expect(await gtd.queuedOps(page)).toHaveLength(0);

            const routines = await gtd.listRoutines(page);
            expect(routines).toHaveLength(1);
            const [routine] = routines;
            if (!routine) throw new Error('expected the created routine');
            expect(routine.title).toBe('Water the plants');
            expect(routine.active).toBe(true);
            expect(routine.routineType).toBe('nextAction');

            const items = await gtd.listItems(page);
            const original = items.find((i) => i._id === inbox._id);
            expect(original?.status).toBe('trash');
            const seeded = items.find((i) => i.routineId === routine._id);
            expect(seeded?.status).toBe('nextAction');
            expect(seeded?.title).toBe('Water the plants');
        });
    });

    test('calendar-type routine from clarify generates horizon calendar items', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `clar-routine-cal-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Morning swim');
            await gtd.flush(page); // see the flush-lock note in the first test
            await page.goto('/inbox');
            await page.waitForSelector('text=Morning swim');

            await page.getByRole('button', { name: 'Edit' }).first().click();
            const dialog = page.getByRole('dialog', { name: 'Edit item' });
            await dialog.getByRole('button', { name: 'Routine' }).click();

            // Switch the embedded routine form's type to Calendar and set a start time.
            const routineFields = dialog.getByTestId('itemEditorRoutineFields');
            await routineFields.getByRole('button', { name: 'Calendar', exact: true }).click();
            await routineFields.getByLabel('Start time').fill('07:30');

            await dialog.getByRole('button', { name: 'Save changes' }).click();
            await expect(dialog).toBeHidden();

            await gtd.flush(page);
            const routines = await gtd.listRoutines(page);
            expect(routines).toHaveLength(1);
            const [routine] = routines;
            if (!routine) throw new Error('expected the created routine');
            expect(routine.routineType).toBe('calendar');
            expect(routine.calendarItemTemplate).toEqual({ timeOfDay: '07:30', duration: 60 });

            const items = await gtd.listItems(page);
            expect(items.find((i) => i._id === inbox._id)?.status).toBe('trash');
            const generated = items.filter((i) => i.routineId === routine._id);
            expect(generated.length).toBeGreaterThan(1);
            expect(generated.every((i) => i.status === 'calendar')).toBe(true);
        });
    });

    test('undo restores the inbox item and deletes the routine with its generated items', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `clar-routine-undo-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Weekly review');
            await gtd.flush(page); // see the flush-lock note in the first test
            await page.goto('/inbox');
            await page.waitForSelector('text=Weekly review');

            await page.getByRole('button', { name: 'Edit' }).first().click();
            const dialog = page.getByRole('dialog', { name: 'Edit item' });
            await dialog.getByRole('button', { name: 'Routine' }).click();
            await dialog.getByRole('button', { name: 'Save changes' }).click();
            await expect(dialog).toBeHidden();

            const snackbar = page.getByTestId('undoSnackbar');
            await expect(snackbar).toContainText('Routine created');
            await page.getByTestId('undoSnackbarButton').click();
            await expect(snackbar).toBeHidden();

            await gtd.flush(page);
            expect(await gtd.listRoutines(page)).toHaveLength(0);
            const items = await gtd.listItems(page);
            expect(items).toHaveLength(1);
            const [restored] = items;
            if (!restored) throw new Error('expected the restored inbox item');
            expect(restored._id).toBe(inbox._id);
            expect(restored.status).toBe('inbox');
        });
    });

    test('Routine chip is not offered for non-inbox items', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `clar-routine-hidden-${dayjs().valueOf()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'Already actionable');
            await gtd.clarifyToNextAction(page, inbox, {});
            await gtd.flush(page); // see the flush-lock note in the first test
            await page.goto('/next-actions');
            await page.waitForSelector('text=Already actionable');

            await page.getByTestId('nextActionItemRow').filter({ hasText: 'Already actionable' }).click();
            const dialog = page.getByRole('dialog', { name: 'Edit item' });
            await expect(dialog).toBeVisible();

            // The status row offers every real status but no Routine destination.
            await expect(dialog.getByRole('button', { name: 'Waiting For' })).toBeVisible();
            await expect(dialog.getByRole('button', { name: 'Routine' })).toHaveCount(0);
        });
    });
});
