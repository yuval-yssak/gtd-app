import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice, withTwoLoggedInDevices } from './helpers/context';
import { gtd } from './helpers/gtd';

// Routine editor hybrid model: title/notes autosave with Undo; schedule/type/template still
// commit via the explicit Save button (those edits can split the routine or regenerate items).

const DAILY = { routineType: 'nextAction' as const, rrule: 'FREQ=DAILY;INTERVAL=1', template: {}, active: true };

test.describe('routine editor — title/notes autosave', () => {
    test('title autosaves without Save and Undo restores it', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routine-autosave-${dayjs().valueOf()}@example.com`, async (page) => {
            await gtd.createRoutine(page, { ...DAILY, title: 'Water the plants' });
            await page.goto('/routines');

            await page.getByTestId('routineRow').filter({ hasText: 'Water the plants' }).click();
            const dialog = page.getByRole('dialog', { name: 'Edit routine' });
            await dialog.getByLabel('Title').fill('Water all the plants');

            await expect(page.getByTestId('undoSnackbar')).toBeVisible();
            await expect.poll(async () => (await gtd.listRoutines(page)).map((r) => r.title)).toContain('Water all the plants');

            await page.getByTestId('undoSnackbarButton').click();
            await expect.poll(async () => (await gtd.listRoutines(page)).map((r) => r.title)).toContain('Water the plants');
            await expect(dialog.getByLabel('Title')).toHaveValue('Water the plants');
        });
    });

    test('schedule edits do NOT autosave — only Save commits them', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `routine-schedule-${dayjs().valueOf()}@example.com`, async (page) => {
            const routine = await gtd.createRoutine(page, { ...DAILY, title: 'Weekly review' });
            await page.goto('/routines');

            await page.getByTestId('routineRow').filter({ hasText: 'Weekly review' }).click();
            const dialog = page.getByRole('dialog', { name: 'Edit routine' });
            // Structural change: flip Ends mode. Wait past the autosave debounce, then verify
            // nothing was persisted before closing without Save.
            await dialog.getByRole('button', { name: 'After N' }).click();
            await page.waitForTimeout(1200);
            const beforeClose = (await gtd.listRoutines(page)).find((r) => r._id === routine._id);
            expect(beforeClose?.rrule).toBe('FREQ=DAILY;INTERVAL=1');
            await dialog.getByRole('button', { name: 'Cancel' }).click();

            const after = (await gtd.listRoutines(page)).find((r) => r._id === routine._id);
            expect(after?.rrule).toBe('FREQ=DAILY;INTERVAL=1');
        });
    });
});

test.describe('routine editor — live merge while open', () => {
    test('remote rename flows into a clean open editor; dirty local field conflicts surface a notice', async ({ browser }) => {
        const email = `routine-merge-${dayjs().valueOf()}@example.com`;
        await withTwoLoggedInDevices(browser, email, async (page1, page2) => {
            const routine = await gtd.createRoutine(page1, { ...DAILY, title: 'Merge routine' });
            await gtd.flush(page1);
            await gtd.pull(page2);

            await page1.goto('/routines');
            await page1.getByTestId('routineRow').filter({ hasText: 'Merge routine' }).click();
            const dialog = page1.getByRole('dialog', { name: 'Edit routine' });
            await expect(dialog.getByLabel('Title')).toHaveValue('Merge routine');

            // Clean title → adopted silently.
            const onDevice2 = (await gtd.listRoutines(page2)).find((r) => r._id === routine._id);
            if (!onDevice2) throw new Error('routine did not reach device 2');
            await gtd.updateRoutine(page2, { ...onDevice2, title: 'Merge routine (remote)' });
            await gtd.flush(page2);
            await expect(dialog.getByLabel('Title')).toHaveValue('Merge routine (remote)', { timeout: 15_000 });
            await expect(page1.getByTestId('routineEditorConflictNotice')).toHaveCount(0);

            // Now dirty a STRUCTURAL field locally (Ends mode — not autosaved, pending until Save),
            // then change the same concept remotely → conflict notice. Text fields converge via
            // autosave + adoption, so a durable conflict needs a structural field.
            await dialog.getByRole('button', { name: 'After N' }).click();
            await gtd.pull(page2);
            const latestRemote = (await gtd.listRoutines(page2)).find((r) => r._id === routine._id);
            if (!latestRemote) throw new Error('routine missing on device 2');
            await gtd.updateRoutine(page2, { ...latestRemote, rrule: 'FREQ=DAILY;INTERVAL=1;UNTIL=20270101T235959Z' });
            await gtd.flush(page2);

            const notice = page1.getByTestId('routineEditorConflictNotice');
            await expect(notice).toBeVisible({ timeout: 15_000 });
            await expect(notice).toContainText('Ends');

            // "Use their version" adopts the remote UNTIL clause → Ends mode becomes "On date".
            await page1.getByTestId('routineEditorUseTheirs').click();
            await expect(notice).toHaveCount(0);
            await expect(dialog.getByLabel('End date')).toHaveValue('2027-01-01');
        });
    });
});
