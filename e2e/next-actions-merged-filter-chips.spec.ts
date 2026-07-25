import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withTwoAccountsOnOneDevice } from './helpers/context';
import { seedNextActionForUser, seedWorkContextForUser } from './helpers/seed';

// With two signed-in accounts each owning its own copy of common contexts ("agenda", "computer"),
// the /next-actions filter rows used to render one chip per entity — indistinguishable duplicates.
// Same-named contexts/people now collapse into a single chip that filters across every account's
// twin; the URL keeps one id and deep links carrying either twin id select the same merged chip.

async function rowTitles(page: Page): Promise<string[]> {
    const visibleTitles = await page.getByTestId('nextActionItemRow').allInnerTexts();
    return visibleTitles.map((t) => t.split('\n')[0]?.trim() ?? '');
}

/** The toggle renders once per AccountSwitcher mount point; only the permanent drawer's instance
 *  is interactable on the desktop viewport, so scope every query to the visible one. */
function visibleToggleFor(page: Page, userId: string) {
    return page.getByTestId(`accountVisibilityToggle-${userId}`).filter({ visible: true });
}

test.describe('next actions — merged multi-account filter chips', () => {
    test('same-named contexts render one chip that filters across both accounts', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const emailA = `merged-chip-a-${stamp}@example.com`;
        const emailB = `merged-chip-b-${stamp}@example.com`;

        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            const agendaA = await seedWorkContextForUser(page, active.userId, 'agenda');
            const agendaB = await seedWorkContextForUser(page, secondary.userId, 'agenda');
            const soloA = await seedWorkContextForUser(page, active.userId, 'solo');
            await seedNextActionForUser(page, active.userId, 'A agenda item', [agendaA]);
            await seedNextActionForUser(page, secondary.userId, 'B agenda item', [agendaB]);
            await seedNextActionForUser(page, active.userId, 'A solo item', [soloA]);

            await page.goto('/next-actions');
            await page.waitForSelector('text=A agenda item');

            // One "agenda" chip despite two same-named contexts; "solo" renders normally.
            await expect(page.getByTestId('nextActionsContextFilterChip')).toHaveText(['agenda', 'solo']);

            // Clicking the merged chip filters items tagged with EITHER account's twin.
            await page.getByTestId('nextActionsContextFilterChip').filter({ hasText: 'agenda' }).click();
            await expect(page).toHaveURL(/context=seed-ctx-/);
            await expect.poll(() => rowTitles(page)).toEqual(expect.arrayContaining(['A agenda item', 'B agenda item']));
            expect(await rowTitles(page)).toHaveLength(2);

            // Second click clears the filter.
            await page.getByTestId('nextActionsContextFilterChip').filter({ hasText: 'agenda' }).click();
            await expect(page).not.toHaveURL(/context=/);
            await expect.poll(async () => (await rowTitles(page)).length).toBe(3);
        });
    });

    test('a deep link carrying the other twin id still selects the merged chip and matches both accounts', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const emailA = `merged-deep-a-${stamp}@example.com`;
        const emailB = `merged-deep-b-${stamp}@example.com`;

        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            const agendaA = await seedWorkContextForUser(page, active.userId, 'agenda');
            const agendaB = await seedWorkContextForUser(page, secondary.userId, 'agenda');
            await seedNextActionForUser(page, active.userId, 'A agenda item', [agendaA]);
            await seedNextActionForUser(page, secondary.userId, 'B agenda item', [agendaB]);

            // The canonical id is the lexicographically smallest of the group — deep-link with the
            // OTHER one to prove non-canonical twin ids still resolve.
            const nonCanonicalId = agendaA < agendaB ? agendaB : agendaA;
            await page.goto(`/next-actions?context=${nonCanonicalId}`);
            await page.waitForSelector('text=agenda item');

            const agendaChip = page.getByTestId('nextActionsContextFilterChip').filter({ hasText: 'agenda' });
            await expect(agendaChip).toHaveClass(/MuiChip-filled/);
            await expect.poll(() => rowTitles(page)).toEqual(expect.arrayContaining(['A agenda item', 'B agenda item']));
            expect(await rowTitles(page)).toHaveLength(2);
        });
    });

    test('hiding the account owning the URL-held twin id keeps the chip active and the list coherent', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        const emailA = `merged-hidden-a-${stamp}@example.com`;
        const emailB = `merged-hidden-b-${stamp}@example.com`;

        await withTwoAccountsOnOneDevice(browser, [emailA, emailB], async (page, { active, secondary }) => {
            const agendaA = await seedWorkContextForUser(page, active.userId, 'agenda');
            const agendaB = await seedWorkContextForUser(page, secondary.userId, 'agenda');
            await seedNextActionForUser(page, active.userId, 'A agenda item', [agendaA]);
            await seedNextActionForUser(page, secondary.userId, 'B agenda item', [agendaB]);

            // Filter via B's twin id, then hide account B — the URL id's owner disappears from the
            // visible sets, but the chip must stay lit (resolved by name via all*) and A's item
            // must keep matching. Before the resolver fix this rendered an unselected chip over an
            // inexplicably filtered-empty list.
            await page.goto(`/next-actions?context=${agendaB}`);
            await page.waitForSelector('text=A agenda item');
            await visibleToggleFor(page, secondary.userId).click();

            const agendaChip = page.getByTestId('nextActionsContextFilterChip').filter({ hasText: 'agenda' });
            await expect(agendaChip).toHaveClass(/MuiChip-filled/);
            await expect.poll(() => rowTitles(page)).toEqual(['A agenda item']);
        });
    });
});
