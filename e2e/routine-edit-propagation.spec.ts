import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Routine edits must propagate to the routine's open generated item IMMEDIATELY (agreed
// semantics: 3-way content merge — hand-tweaks survive; schedule edits recompute dates
// unconditionally). These specs drive the real editor UI end-to-end and assert on IDB state.

/** The routine's open item still in its native nextAction status. */
async function openItemOf(page: Parameters<typeof gtd.listItems>[0], routineId: string) {
    const items = await gtd.listItems(page);
    return items.find((i) => i.routineId === routineId && i.status === 'nextAction');
}

/** Opens the edit dialog for the routine row containing `title` on /routines (tab-aware). */
async function openRoutineEditor(page: Parameters<typeof gtd.listItems>[0], title: string, tab?: 'calendar') {
    await page.goto(tab ? `/routines?tab=${tab}` : '/routines');
    await page.waitForSelector(`text=${title}`);
    await page.getByTestId('routineRow').filter({ hasText: title }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit routine' });
    await expect(dialog).toBeVisible();
    return dialog;
}

test.describe('Routine edit → open next action propagation', () => {
    test('adding a work context on the routine updates the open next action immediately', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routine-prop-wc-${dayjs().valueOf()}@example.com`, async (page) => {
            const workContext = await gtd.createWorkContext(page, 'Errands');
            const routine = await gtd.createRoutine(page, {
                title: 'Water plants',
                routineType: 'nextAction',
                rrule: 'FREQ=DAILY;INTERVAL=1',
                template: {},
                active: true,
            });
            await gtd.materializePendingNextActionRoutines(page);
            expect(await openItemOf(page, routine._id)).toBeTruthy();

            const dialog = await openRoutineEditor(page, 'Water plants');
            await dialog.getByText('Errands').click();
            await dialog.getByTestId('routineEditorSaveButton').click();
            await expect(dialog).toBeHidden();

            await expect.poll(async () => (await openItemOf(page, routine._id))?.workContextIds ?? []).toEqual([workContext._id]);
        });
    });

    test('hand-tweaked energy survives while other template edits adopt', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routine-prop-merge-${dayjs().valueOf()}@example.com`, async (page) => {
            const workContext = await gtd.createWorkContext(page, 'Home');
            const routine = await gtd.createRoutine(page, {
                title: 'Stretch',
                routineType: 'nextAction',
                rrule: 'FREQ=DAILY;INTERVAL=1',
                template: { energy: 'low' },
                active: true,
            });
            await gtd.materializePendingNextActionRoutines(page);
            const open = await openItemOf(page, routine._id);
            if (!open) throw new Error('expected a materialized open item');
            // Hand-tweak the ITEM's energy — the routine edit below must not clobber it.
            await gtd.updateItem(page, { ...open, energy: 'high' });

            const dialog = await openRoutineEditor(page, 'Stretch');
            await dialog.getByRole('button', { name: 'Medium' }).click();
            await dialog.getByText('Home').click();
            await dialog.getByTestId('routineEditorSaveButton').click();
            await expect(dialog).toBeHidden();

            await expect.poll(async () => (await openItemOf(page, routine._id))?.workContextIds ?? []).toEqual([workContext._id]);
            const after = await openItemOf(page, routine._id);
            expect(after?.energy).toBe('high');
        });
    });

    test('title autosave renames the open next action without pressing Save', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routine-prop-title-${dayjs().valueOf()}@example.com`, async (page) => {
            const routine = await gtd.createRoutine(page, {
                title: 'Journal',
                routineType: 'nextAction',
                rrule: 'FREQ=DAILY;INTERVAL=1',
                template: {},
                active: true,
            });
            await gtd.materializePendingNextActionRoutines(page);

            const dialog = await openRoutineEditor(page, 'Journal');
            const titleInput = dialog.getByRole('textbox', { name: 'Title' });
            await titleInput.fill('Journal every morning');
            // Blur flushes the debounced autosave commit — no explicit Save.
            await titleInput.blur();

            await expect.poll(async () => (await openItemOf(page, routine._id))?.title).toBe('Journal every morning');
            await dialog.getByRole('button', { name: 'Cancel' }).click();
        });
    });

    test('frequency change recomputes the open item date (manual reschedule overwritten)', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routine-prop-sched-${dayjs().valueOf()}@example.com`, async (page) => {
            const routine = await gtd.createRoutine(page, {
                title: 'Weekly review',
                routineType: 'nextAction',
                rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU',
                template: {},
                active: true,
            });
            await gtd.materializePendingNextActionRoutines(page);
            const open = await openItemOf(page, routine._id);
            if (!open) throw new Error('expected a materialized open item');
            // Push the item's date a week out so the recompute visibly moves it back to today.
            const nextWeek = dayjs().add(7, 'day').format('YYYY-MM-DD');
            await gtd.updateItem(page, { ...open, expectedBy: nextWeek, ignoreBefore: nextWeek });

            // Frequency: weekly(all days) → "Every X days" (daily). Canonical rrule changes.
            const dialog = await openRoutineEditor(page, 'Weekly review');
            await dialog.getByRole('radio', { name: 'Every X days' }).check();
            await dialog.getByTestId('routineEditorSaveButton').click();
            await expect(dialog).toBeHidden();

            const today = dayjs().format('YYYY-MM-DD');
            await expect.poll(async () => (await openItemOf(page, routine._id))?.expectedBy).toBe(today);
            const afterFreq = await openItemOf(page, routine._id);
            expect(afterFreq?.ignoreBefore).toBe(today);
            expect(afterFreq?._id).toBe(open._id);
        });
    });

    test('startDate change restamps a surviving future open item instead of duplicating it', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routine-prop-startdate-${dayjs().valueOf()}@example.com`, async (page) => {
            const routine = await gtd.createRoutine(page, {
                title: 'Water garden',
                routineType: 'nextAction',
                rrule: 'FREQ=DAILY;INTERVAL=1',
                template: {},
                active: true,
            });
            await gtd.materializePendingNextActionRoutines(page);
            const open = await openItemOf(page, routine._id);
            if (!open) throw new Error('expected a materialized open item');
            // Future-date the item so it survives the startDate-change past-item cleanup —
            // this is exactly the shape that used to produce a DUPLICATE open item.
            const tomorrow = dayjs().add(1, 'day').format('YYYY-MM-DD');
            await gtd.updateItem(page, { ...open, expectedBy: tomorrow, ignoreBefore: tomorrow });

            const inFiveDays = dayjs().add(5, 'day').format('YYYY-MM-DD');
            const dialog = await openRoutineEditor(page, 'Water garden');
            await dialog.getByLabel('Start date').fill(inFiveDays);
            await dialog.getByTestId('routineEditorSaveButton').click();
            await expect(dialog).toBeHidden();

            await expect.poll(async () => (await openItemOf(page, routine._id))?.expectedBy).toBe(inFiveDays);
            const items = (await gtd.listItems(page)).filter((i) => i.routineId === routine._id && i.status === 'nextAction');
            expect(items).toHaveLength(1);
            expect(items[0]?._id).toBe(open._id);
            expect(items[0]?.ignoreBefore).toBe(inFiveDays);
        });
    });

    test('calendar routine notes edit updates future generated calendar items in place', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routine-prop-cal-notes-${dayjs().valueOf()}@example.com`, async (page) => {
            const routine = await gtd.createRoutine(page, {
                title: 'Morning swim',
                routineType: 'calendar',
                rrule: 'FREQ=DAILY;INTERVAL=1',
                template: {},
                active: true,
                calendarItemTemplate: { timeOfDay: '09:00', duration: 60 },
            });
            await gtd.generateCalendarItemsToHorizon(page, routine._id);
            const before = (await gtd.listItems(page)).filter((i) => i.routineId === routine._id && i.status === 'calendar');
            expect(before.length).toBeGreaterThan(0);

            const dialog = await openRoutineEditor(page, 'Morning swim', 'calendar');
            await dialog.getByRole('textbox', { name: 'Notes (Markdown)' }).fill('bring goggles');
            await dialog.getByTestId('routineEditorSaveButton').click();
            await expect(dialog).toBeHidden();

            const tomorrow = dayjs().add(1, 'day').format('YYYY-MM-DD');
            await expect
                .poll(async () => {
                    const items = await gtd.listItems(page);
                    return items.find((i) => i.routineId === routine._id && i.status === 'calendar' && i.timeStart?.startsWith(tomorrow))?.notes;
                })
                .toBe('bring goggles');
            // Item IDs preserved — content refresh, not delete+recreate.
            const after = (await gtd.listItems(page)).filter((i) => i.routineId === routine._id && i.status === 'calendar');
            expect(after.map((i) => i._id).sort()).toEqual(before.map((i) => i._id).sort());
        });
    });
});
