import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Switching a routine's type (nextAction ↔ calendar) must clean up the OLD type's generated
// items and seed the new type immediately: nextAction → calendar trashes the open next action
// and fills the calendar horizon; calendar → nextAction trashes only UPCOMING calendar items
// (past occurrences remain as history) and seeds the first next action.

/** Opens the edit dialog for the routine row containing `title` on /routines (tab-aware). */
async function openRoutineEditor(page: Parameters<typeof gtd.listItems>[0], title: string, tab?: 'calendar') {
    await page.goto(tab ? `/routines?tab=${tab}` : '/routines');
    await page.waitForSelector(`text=${title}`);
    await page.getByTestId('routineRow').filter({ hasText: title }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit routine' });
    await expect(dialog).toBeVisible();
    return dialog;
}

test.describe('Routine type switch (nextAction ↔ calendar)', () => {
    test('nextAction → calendar: open next action trashed, calendar horizon filled', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `type-switch-na-cal-${dayjs().valueOf()}@example.com`, async (page) => {
            const routine = await gtd.createRoutine(page, {
                title: 'Water plants',
                routineType: 'nextAction',
                rrule: 'FREQ=DAILY;INTERVAL=1',
                template: {},
                active: true,
            });
            await gtd.materializePendingNextActionRoutines(page);
            const open = (await gtd.listItems(page)).find((i) => i.routineId === routine._id && i.status === 'nextAction');
            expect(open).toBeTruthy();

            const dialog = await openRoutineEditor(page, 'Water plants');
            await dialog.getByRole('button', { name: 'Calendar' }).click();
            await dialog.getByTestId('routineEditorSaveButton').click();
            await expect(dialog).toBeHidden();

            // Old open next action is trashed — not left orphaned in the Next Actions list.
            await expect.poll(async () => (await gtd.listItems(page)).find((i) => i._id === open?._id)?.status).toBe('trash');
            const calendarItems = (await gtd.listItems(page)).filter((i) => i.routineId === routine._id && i.status === 'calendar');
            expect(calendarItems.length).toBeGreaterThan(0);
            const stored = (await gtd.listRoutines(page)).find((r) => r._id === routine._id);
            expect(stored?.routineType).toBe('calendar');
        });
    });

    test('calendar → nextAction: upcoming items trashed, past history kept, next action seeded', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `type-switch-cal-na-${dayjs().valueOf()}@example.com`, async (page) => {
            const routine = await gtd.createRoutine(page, {
                title: 'Morning swim',
                routineType: 'calendar',
                rrule: 'FREQ=DAILY;INTERVAL=1',
                template: {},
                active: true,
                calendarItemTemplate: { timeOfDay: '09:00', duration: 30 },
            });
            await gtd.generateCalendarItemsToHorizon(page, routine._id);
            const futureItems = (await gtd.listItems(page)).filter((i) => i.routineId === routine._id && i.status === 'calendar');
            expect(futureItems.length).toBeGreaterThan(0);

            // Craft a PAST occurrence — the switch must leave it untouched as history.
            const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
            const seed = await gtd.collect(page, 'Morning swim (past)');
            const pastItem = await gtd.updateItem(page, {
                ...seed,
                status: 'calendar',
                routineId: routine._id,
                timeStart: `${yesterday}T09:00:00`,
                timeEnd: `${yesterday}T09:30:00`,
            });

            const dialog = await openRoutineEditor(page, 'Morning swim', 'calendar');
            await dialog.getByRole('button', { name: 'Next Action' }).click();
            await dialog.getByTestId('routineEditorSaveButton').click();
            await expect(dialog).toBeHidden();

            // Upcoming occurrences are trashed; the past one survives as history.
            await expect
                .poll(async () => {
                    const items = await gtd.listItems(page);
                    return items.filter((i) => i.routineId === routine._id && i.status === 'calendar' && (i.timeStart ?? '') >= dayjs().format('YYYY-MM-DD'))
                        .length;
                })
                .toBe(0);
            const past = (await gtd.listItems(page)).find((i) => i._id === pastItem._id);
            expect(past?.status).toBe('calendar');

            // Exactly one fresh next action is seeded for the routine.
            const seeded = (await gtd.listItems(page)).filter((i) => i.routineId === routine._id && i.status === 'nextAction');
            expect(seeded).toHaveLength(1);
            const stored = (await gtd.listRoutines(page)).find((r) => r._id === routine._id);
            expect(stored?.routineType).toBe('nextAction');
        });
    });
});
