import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// Long context/person chip clouds collapse to the top-8 usage-ranked options behind a "+N more"
// expander (expanded view is alphabetical). The next-actions filter rows additionally show only
// "live" options — chips referenced by at least one item matching the OTHER active filters.

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'] as const;

async function seedTwelveContexts(page: Page) {
    const byLetter = new Map<string, { _id: string }>();
    for (const letter of LETTERS) {
        byLetter.set(letter, await gtd.createWorkContext(page, `Ctx ${letter}`));
    }
    return byLetter;
}

async function chipTexts(page: Page, testId: string): Promise<string[]> {
    return page.getByTestId(testId).allInnerTexts();
}

test.describe('collapsible usage-ranked pickers', () => {
    test('item editor collapses 12 contexts to the top 8 (most-used first) and expands alphabetically', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `collapse-editor-${dayjs().valueOf()}@example.com`, async (page) => {
            const contexts = await seedTwelveContexts(page);
            const ctxL = contexts.get('L');
            if (!ctxL) throw new Error('expected Ctx L to be seeded');
            // Ctx L is the only context with usage — a different item references it.
            await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Uses L'), { workContextIds: [ctxL._id] });
            const bare = await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Untagged'), {});

            await page.goto(`/item/${bare._id}`);
            await expect(page.getByTestId('itemPageWrapper')).toBeVisible();

            // Collapsed: 8 chips, most-used ("Ctx L") first, the rest A→Z; 4 fold behind "+4 more".
            await expect(page.getByTestId('editorWorkContextChip')).toHaveCount(8);
            expect(await chipTexts(page, 'editorWorkContextChip')).toEqual(['Ctx L', 'Ctx A', 'Ctx B', 'Ctx C', 'Ctx D', 'Ctx E', 'Ctx F', 'Ctx G']);
            const showMore = page.getByTestId('editorWorkContextChipShowMore');
            await expect(showMore).toHaveText('+4 more');

            // Expanded: full list A→Z plus a "Show fewer" collapse chip.
            await showMore.click();
            await expect(page.getByTestId('editorWorkContextChip')).toHaveCount(12);
            expect(await chipTexts(page, 'editorWorkContextChip')).toEqual(LETTERS.map((letter) => `Ctx ${letter}`));

            // Selecting a below-the-fold chip keeps it visible after collapsing again.
            await page.getByTestId('editorWorkContextChip').filter({ hasText: 'Ctx K' }).click();
            await page.getByTestId('editorWorkContextChipShowFewer').click();
            await expect(page.getByTestId('editorWorkContextChip')).toHaveCount(9);
            await expect(page.getByTestId('editorWorkContextChip').filter({ hasText: 'Ctx K' })).toHaveClass(/MuiChip-filled/);
        });
    });

    test('next-actions filter rows offer only live options, faceted by the other filters', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `live-options-${dayjs().valueOf()}@example.com`, async (page) => {
            const phone = await gtd.createWorkContext(page, 'Phone');
            const errands = await gtd.createWorkContext(page, 'Errands');
            await gtd.createWorkContext(page, 'Ghost'); // never referenced — must not render a chip
            await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Call landlord'), { workContextIds: [phone._id], energy: 'low' });
            await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Buy stamps'), { workContextIds: [errands._id], energy: 'high' });

            await page.goto('/next-actions');
            await page.waitForSelector('text=Call landlord');

            // "Ghost" has no referencing next action — no chip.
            await expect(page.getByTestId('nextActionsContextFilterChip')).toHaveText(['Errands', 'Phone']);

            // Faceting: with the low-energy filter on, only contexts of low-energy items remain.
            await page.getByTestId('nextActionsEnergyFilterChip').filter({ hasText: 'Low energy' }).click();
            await expect(page.getByTestId('nextActionsContextFilterChip')).toHaveText(['Phone']);

            // Clearing the energy filter restores both live chips.
            await page.getByTestId('nextActionsEnergyFilterChip').filter({ hasText: 'Low energy' }).click();
            await expect(page.getByTestId('nextActionsContextFilterChip')).toHaveText(['Errands', 'Phone']);
        });
    });

    test('search page filters by chip rows instead of dropdowns, with collapse', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `search-chips-${dayjs().valueOf()}@example.com`, async (page) => {
            const contexts = await seedTwelveContexts(page);
            const ctxC = contexts.get('C');
            if (!ctxC) throw new Error('expected Ctx C to be seeded');
            await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Tagged with C'), { workContextIds: [ctxC._id] });
            await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Untagged item'), {});

            await page.goto('/search');
            await page.waitForSelector('text=Search');

            // Collapsed to 8 with "+4 more"; expanding shows all 12.
            await expect(page.getByTestId('searchContextFilterChip')).toHaveCount(8);
            await page.getByTestId('searchContextFilterChipShowMore').click();
            await expect(page.getByTestId('searchContextFilterChip')).toHaveCount(12);

            // Selecting a context chip filters results and lights the chip. The URL holds the
            // merged option's canonicalId — equal to ctxC._id only because every seeded context
            // name is unique here; a same-named twin would make the chip emit the smaller twin id.
            await page.getByTestId('searchContextFilterChip').filter({ hasText: 'Ctx C' }).click();
            await expect(page).toHaveURL(new RegExp(`contextId=${ctxC._id}`));
            await expect(page.getByText('Tagged with C')).toBeVisible();
            await expect(page.getByText('Untagged item')).toHaveCount(0);

            // Clicking the active chip again clears the filter (the URL keeps a contextId=null
            // param — same serialization the old dropdown produced — so assert on state, not URL).
            await page.getByTestId('searchContextFilterChip').filter({ hasText: 'Ctx C' }).click();
            await expect(page.getByTestId('searchContextFilterChip').filter({ hasText: 'Ctx C' })).not.toHaveClass(/MuiChip-filled/);
            await expect(page.getByText('Untagged item')).toBeVisible();
        });
    });
});
