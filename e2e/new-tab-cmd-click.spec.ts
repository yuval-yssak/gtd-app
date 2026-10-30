import { expect, type Page, test } from '@playwright/test';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';
import { uniqueStamp } from './helpers/uniqueStamp';

// cmd+click (macOS) / ctrl+click (Windows, Linux) on an entity row must open that entity's
// page in a NEW tab — matching the browser's native link gesture — instead of running the
// in-tab action (inline editor or same-tab navigation).

interface ModifiedClickCase {
    rowTestId: string;
    rowText: string;
    expectedNewTabUrl: string | RegExp;
}

/** Modifier-clicks the row, waits for the resulting tab, and asserts the origin tab stayed put with no editor. */
async function expectModifiedClickOpensNewTab(page: Page, { rowTestId, rowText, expectedNewTabUrl }: ModifiedClickCase) {
    const originUrl = page.url();
    const [newTab] = await Promise.all([
        page.context().waitForEvent('page'),
        page
            .getByTestId(rowTestId)
            .filter({ hasText: rowText })
            .click({ modifiers: ['ControlOrMeta'] }),
    ]);
    await newTab.waitForURL(expectedNewTabUrl);

    // The originating tab stays on its list — the editor did not open there.
    expect(page.url()).toBe(originUrl);
    await expect(page.getByTestId('itemPageWrapper')).toHaveCount(0);
    await newTab.close();
}

test.describe('cmd/ctrl+click opens entity pages in a new tab', () => {
    test('next-actions: modified row click opens /item/<id> in a new tab without an in-tab dialog', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `newtab-na-${uniqueStamp()}@example.com`, async (page) => {
            const inbox = await gtd.collect(page, 'New tab target');
            const item = await gtd.clarifyToNextAction(page, inbox, { energy: 'low', time: 5 });

            await page.goto('/next-actions');
            await page.waitForSelector('text=New tab target');

            await expectModifiedClickOpensNewTab(page, {
                rowTestId: 'nextActionItemRow',
                rowText: 'New tab target',
                expectedNewTabUrl: `**/item/${item._id}*`,
            });
        });
    });

    test('people: modified row click opens /person/<id> in a new tab', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `newtab-people-${uniqueStamp()}@example.com`, async (page) => {
            const person = await gtd.createPerson(page, { name: 'Navina Newtab' });

            await page.goto('/people');
            await page.waitForSelector('text=Navina Newtab');

            await expectModifiedClickOpensNewTab(page, {
                rowTestId: 'personRowText',
                rowText: 'Navina Newtab',
                expectedNewTabUrl: `**/person/${person._id}*`,
            });
        });
    });

    test('work contexts: modified row click opens /work-context/<id> in a new tab', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `newtab-contexts-${uniqueStamp()}@example.com`, async (page) => {
            const workContext = await gtd.createWorkContext(page, '@newtab');
            await gtd.flush(page);

            await page.goto('/work-contexts');
            await page.waitForSelector('text=@newtab');

            await expectModifiedClickOpensNewTab(page, {
                rowTestId: 'workContextRowText',
                rowText: '@newtab',
                expectedNewTabUrl: `**/work-context/${workContext._id}*`,
            });
        });
    });

    test('routines: modified row click opens /routine/<id> in a new tab instead of the editor', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `newtab-routines-${uniqueStamp()}@example.com`, async (page) => {
            const routine = await gtd.createRoutine(page, {
                title: 'New tab routine',
                routineType: 'nextAction',
                rrule: 'FREQ=DAILY',
                template: { energy: 'low' },
                active: true,
            });

            await page.goto('/routines');
            await page.waitForSelector('text=New tab routine');

            await expectModifiedClickOpensNewTab(page, {
                rowTestId: 'routineRow',
                rowText: 'New tab routine',
                expectedNewTabUrl: `**/routine/${routine._id}*`,
            });
        });
    });

    test('undo snackbar: modified View click opens the item in a new tab and keeps the snackbar', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `newtab-undo-${uniqueStamp()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Undo view new tab');
            await page.goto('/inbox');
            await page.waitForSelector('text=Undo view new tab');

            // Clarify via the UI so the "Item updated" undo offer with its View link appears.
            await page.getByRole('button', { name: 'Edit' }).first().click();
            const editor = page.getByTestId('itemPageWrapper');
            await editor.getByRole('button', { name: 'Next Action' }).click();
            await editor.getByRole('button', { name: 'Save changes' }).click();

            const viewButton = page.getByTestId('undoSnackbarViewButton');
            await expect(viewButton).toBeVisible();
            const [newTab] = await Promise.all([page.context().waitForEvent('page'), viewButton.click({ modifiers: ['ControlOrMeta'] })]);
            await newTab.waitForURL(`**/item/${item._id}*`);

            // The origin tab stays on the inbox and the undo offer survives — asserted immediately,
            // well under UNDO_TOAST_DURATION_MS (6s), so auto-hide can't mask a broken handler.
            expect(page.url()).toContain('/inbox');
            await expect(page.getByTestId('undoSnackbar')).toBeVisible();
            await newTab.close();
        });
    });
});
