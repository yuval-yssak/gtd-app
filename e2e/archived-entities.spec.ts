import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Archiving a work context / person soft-retires it: hidden from the next-actions filter rows and
// editor pickers, but existing item references keep rendering (dimmed) and the entity can be
// unarchived from its management page. Person notes are editable and surface as a row snippet.

function rowFor(page: Page, text: string) {
    return page.locator('li').filter({ hasText: text });
}

test.describe('archived work contexts and people', () => {
    test('archiving a context removes it from filters and pickers; unarchiving restores it', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `arch-ctx-${dayjs().valueOf()}@example.com`, async (page) => {
            const phone = await gtd.createWorkContext(page, 'Phone');
            const errands = await gtd.createWorkContext(page, 'Errands');
            await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Call landlord'), { workContextIds: [phone._id] });
            const stamps = await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Buy stamps'), { workContextIds: [errands._id] });

            await page.goto('/next-actions');
            await page.waitForSelector('text=Call landlord');
            await expect(page.getByTestId('nextActionsContextFilterChip')).toHaveText(['Errands', 'Phone']);

            // Archive "Errands" from the management page.
            await page.goto('/work-contexts');
            await rowFor(page, 'Errands').getByTestId('workContextRowArchiveButton').click();
            await expect(rowFor(page, 'Errands').getByTestId('workContextArchivedChip')).toBeVisible();

            // Filter row loses the archived chip even though an open item still references it…
            await page.goto('/next-actions');
            await page.waitForSelector('text=Buy stamps');
            await expect(page.getByTestId('nextActionsContextFilterChip')).toHaveText(['Phone']);
            // …and the referencing row still shows its (dimmed) tag chip.
            await expect(page.getByTestId('nextActionRowTags').filter({ hasText: 'Errands' })).toBeVisible();

            // Editor picker on an untagged-with-Errands item hides the archived context…
            await page.goto(`/item/${stamps._id}`);
            await expect(page.getByTestId('itemPageWrapper')).toBeVisible();
            // …but this item carries the tag, so the chip stays visible and selected (removable).
            await expect(page.getByTestId('editorWorkContextChip')).toHaveText(['Errands', 'Phone']);
            await expect(page.getByTestId('editorWorkContextChip').filter({ hasText: 'Errands' })).toHaveClass(/MuiChip-filled/);

            // Unarchive restores the filter chip.
            await page.goto('/work-contexts');
            await rowFor(page, 'Errands').getByTestId('workContextRowArchiveButton').click();
            await expect(rowFor(page, 'Errands').getByTestId('workContextArchivedChip')).toHaveCount(0);
            await page.goto('/next-actions');
            await page.waitForSelector('text=Buy stamps');
            await expect(page.getByTestId('nextActionsContextFilterChip')).toHaveText(['Errands', 'Phone']);
        });
    });

    test('archiving a person hides them from the person filter row and marks the row Archived', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `arch-person-${dayjs().valueOf()}@example.com`, async (page) => {
            const alice = await gtd.createPerson(page, { name: 'Alice' });
            const bob = await gtd.createPerson(page, { name: 'Bob' });
            await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Ping Alice'), { peopleIds: [alice._id] });
            await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Ping Bob'), { peopleIds: [bob._id] });

            await page.goto('/next-actions');
            await page.waitForSelector('text=Ping Alice');
            await expect(page.getByTestId('nextActionsPersonFilterChip')).toHaveText(['Alice', 'Bob']);

            await page.goto('/people');
            await rowFor(page, 'Bob').getByTestId('personRowArchiveButton').click();
            await expect(rowFor(page, 'Bob').getByTestId('personArchivedChip')).toBeVisible();
            // Archived rows sink below active ones (scope to person rows — the nav renders <li>s too).
            const personRows = page.locator('li').filter({ has: page.getByTestId('personRowArchiveButton') });
            await expect(personRows.last()).toContainText('Bob');

            await page.goto('/next-actions');
            await page.waitForSelector('text=Ping Alice');
            await expect(page.getByTestId('nextActionsPersonFilterChip')).toHaveText(['Alice']);
        });
    });

    test('unused badge marks entities with no item references', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `unused-${dayjs().valueOf()}@example.com`, async (page) => {
            const used = await gtd.createWorkContext(page, 'Used context');
            await gtd.createWorkContext(page, 'Dormant context');
            await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Do something'), { workContextIds: [used._id] });

            await page.goto('/work-contexts');
            await expect(rowFor(page, 'Dormant context').getByTestId('workContextUnusedChip')).toBeVisible();
            await expect(rowFor(page, 'Used context').getByTestId('workContextUnusedChip')).toHaveCount(0);
        });
    });
});

test.describe('person notes', () => {
    test('notes can be added on create, surface as a row snippet, and edit via the dialog autosaves', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `person-notes-${dayjs().valueOf()}@example.com`, async (page) => {
            await page.goto('/people');
            await page.getByRole('button', { name: 'Add person' }).click();
            await page.getByLabel('Name').fill('Nadia');
            await page.getByTestId('personCreateNotes').locator('textarea').first().fill('Met at the conference\nFollow up quarterly');
            await page.getByRole('button', { name: 'Add', exact: true }).click();

            // First non-empty notes line renders as the row snippet.
            await expect(rowFor(page, 'Nadia').getByTestId('personNotesSnippet')).toHaveText('Met at the conference');

            // Edit dialog exposes the full notes and autosaves changes.
            await rowFor(page, 'Nadia').getByTestId('personRowEditButton').click();
            const notesField = page.getByTestId('personEditNotes').locator('textarea').first();
            await expect(notesField).toHaveValue('Met at the conference\nFollow up quarterly');
            await notesField.fill('Prefers email');
            await notesField.blur();
            await expect(page.getByText('Person saved')).toBeVisible();
            await page.getByTestId('personEditClose').click();
            await expect(rowFor(page, 'Nadia').getByTestId('personNotesSnippet')).toHaveText('Prefers email');

            // The saved notes survive a reload (round-trips through IDB).
            await page.reload();
            await expect(rowFor(page, 'Nadia').getByTestId('personNotesSnippet')).toHaveText('Prefers email');
        });
    });
});
