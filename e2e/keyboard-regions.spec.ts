import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import type { StoredItem } from '../client/src/types/MyDB';
import { withOneLoggedInDevice, withTwoAccountsOnOneDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

// App-wide keyboard navigation (branch exp/keyboard-regions): the sidebar menu, the account
// avatars, the Next Actions filter bar and its list are each ONE tab stop with arrow keys inside;
// `g` + letter jumps to a page, `?` opens the legend, `/` focuses the list search, F6 cycles regions.

async function seedUndated(page: Page, titles: string[]): Promise<StoredItem[]> {
    const items: StoredItem[] = [];
    for (const title of titles) {
        items.push(await gtd.clarifyToNextAction(page, await gtd.collect(page, title), {}));
    }
    await gtd.flush(page);
    return items;
}

/** What has focus: its test id, else its accessible text, else its tag. */
const focused = (page: Page) =>
    page.evaluate(() => {
        const el = document.activeElement;
        // `||`, not `??`: an input's textContent is an empty string, not null.
        return el?.getAttribute('data-testid') || el?.textContent?.trim() || el?.tagName || '';
    });
const focusedRegion = (page: Page) =>
    page.evaluate(() => document.activeElement?.closest('[data-keyboard-region]')?.getAttribute('data-keyboard-region') ?? '');
const rowOf = (page: Page, title: string) => page.getByTestId('nextActionItemRow').filter({ hasText: title });

test.describe('Keyboard regions and global shortcuts', () => {
    test('the menu is one tab stop entered on the current page; ↓ then Enter navigates; Tab leaves it in one press', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `kb-menu-${dayjs().valueOf()}@example.com`, async (page) => {
            await page.goto('/next-actions');
            await page.waitForSelector('[data-testid="mainMenu"]');

            // From the top of the page: the brand row's keyboard-shortcuts button, then the menu — entered
            // on the CURRENT page's link.
            await page.locator('body').focus();
            await page.keyboard.press('Tab');
            await expect.poll(() => focused(page)).toBe('keyboardShortcutsButton');
            await page.keyboard.press('Tab');
            await expect.poll(() => focused(page)).toBe('Next Actions');
            expect(await focusedRegion(page)).toBe('Main menu');

            await page.keyboard.press('ArrowDown');
            await expect.poll(() => focused(page)).toBe('Calendar');
            await page.keyboard.press('End');
            await expect.poll(() => focused(page)).toBe('Settings');
            await page.keyboard.press('Home');
            await expect.poll(() => focused(page)).toBe('Inbox');

            // One Tab leaves the whole menu (16 links): the next stop is the accounts region.
            await page.keyboard.press('Tab');
            await expect.poll(() => focusedRegion(page)).toBe('Accounts');

            // Shift+Tab returns to the menu — on the CURRENT page's link, the one you are on — and Enter follows a link.
            await page.keyboard.press('Shift+Tab');
            await expect.poll(() => focused(page)).toBe('Next Actions');
            await page.keyboard.press('Home');
            await page.keyboard.press('Enter');
            await expect(page).toHaveURL(/\/inbox$/);
        });
    });

    test('the filter bar is one tab stop: arrows walk the chips, Space toggles a filter, Tab moves on to the list', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `kb-filters-${dayjs().valueOf()}@example.com`, async (page) => {
            await seedUndated(page, ['Alpha', 'Bravo']);
            await page.goto('/next-actions');
            await page.waitForSelector('text=Alpha');

            await page.getByTestId('nextActionsSearchButton').focus();
            await page.keyboard.press('Tab');
            await expect.poll(() => focused(page)).toBe('nextActionsEnergyFilterChip');
            expect(await focusedRegion(page)).toBe('Filters');

            await page.keyboard.press('ArrowRight');
            await expect.poll(() => page.evaluate(() => document.activeElement?.textContent)).toBe('Medium energy');
            await page.keyboard.press('Space');
            await expect(page).toHaveURL(/energy=medium/);
            // Wait for the filtered render (no seeded row has medium energy, so the list region goes):
            // the URL changes before the transition commits, and a second Space inside that window
            // toggles from the stale state and re-applies the filter.
            await expect(page.locator('[data-keyboard-region="Next actions"]')).toHaveCount(0);
            // Space again clears it — and the list must be back before Tab can move into it.
            await page.keyboard.press('Space');
            await expect(page).not.toHaveURL(/energy=/);
            await expect(page.locator('[data-keyboard-region="Next actions"]')).toBeAttached();

            await page.keyboard.press('End');
            await expect.poll(() => focused(page)).toBe('INPUT'); // the "Show tags" switch
            await page.keyboard.press('Tab');
            await expect.poll(() => focusedRegion(page)).toBe('Next actions');

            // Back into the filters: the chip used last, not the first one.
            await page.keyboard.press('Shift+Tab');
            await expect.poll(() => focused(page)).toBe('INPUT');
        });
    });

    test('the account avatars are one tab stop: ←/→ walk the visibility toggles and the switcher; Enter opens its menu', async ({ browser }) => {
        const stamp = dayjs().valueOf();
        await withTwoAccountsOnOneDevice(browser, [`kb-acc-a-${stamp}@example.com`, `kb-acc-b-${stamp}@example.com`], async (page, { active, secondary }) => {
            await page.goto('/next-actions');
            const region = page.getByTestId('accountsRegion').locator('visible=true');
            await expect(region).toHaveCount(1);

            // The toggles render in the device's account order, which need not start with the active one —
            // and the avatar row re-renders (briefly empty) while the accounts list refreshes after boot, so
            // poll until both are there rather than reading once.
            const readToggleIds = () =>
                region.locator('[data-testid^="accountVisibilityToggle-"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
            await expect
                .poll(async () => [...(await readToggleIds())].sort())
                .toEqual([`accountVisibilityToggle-${active.userId}`, `accountVisibilityToggle-${secondary.userId}`].sort());
            const toggleIds = await readToggleIds();
            const [firstToggle, secondToggle] = toggleIds;

            await page.locator('[data-testid="mainMenu"]:visible a').first().focus();
            await page.keyboard.press('Tab');
            await expect.poll(() => focused(page)).toBe(firstToggle);
            await page.keyboard.press('ArrowRight');
            await expect.poll(() => focused(page)).toBe(secondToggle);
            await page.keyboard.press('ArrowRight');
            await expect.poll(() => focused(page)).toBe('accountSwitcherTrigger');
            await page.keyboard.press('ArrowRight'); // clamps at the end
            await expect.poll(() => focused(page)).toBe('accountSwitcherTrigger');
            await page.keyboard.press('Enter');
            await expect(page.getByTestId(`accountSwitcherItem-${secondary.userId}`)).toBeVisible();
        });
    });

    test('g jumps to a page; the hint shows while g is pending; a slow second key and text fields do nothing', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `kb-goto-${dayjs().valueOf()}@example.com`, async (page) => {
            await page.goto('/next-actions');
            await page.waitForSelector('[data-testid="mainMenu"]');
            await page.locator('body').click();

            await page.keyboard.press('g');
            await expect(page.getByTestId('goToHint')).toBeVisible();
            await page.keyboard.press('i');
            await expect(page).toHaveURL(/\/inbox$/);
            await expect(page.getByTestId('goToHint')).toHaveCount(0);
            // The inbox autofocuses its capture field, where g is a letter — step out of it first.
            await page.locator('h5').first().click();

            await page.keyboard.press('g');
            await page.keyboard.press('Shift'); // a bare modifier keeps the jump pending
            await page.keyboard.press('w');
            await expect(page).toHaveURL(/\/waiting-for$/);

            // A modifier pressed late does not extend the jump: the hint goes when the g expires.
            await page.locator('h5').first().click();
            await page.keyboard.press('g');
            await expect(page.getByTestId('goToHint')).toBeVisible();
            await page.waitForTimeout(1000);
            await page.keyboard.press('Shift');
            await page.waitForTimeout(700);
            // An immediate count, not a retrying assertion: an extended hint (gone at ~2.5 s) would pass a 5 s retry.
            expect(await page.getByTestId('goToHint').count()).toBe(0);
            await page.keyboard.press('n');
            await page.waitForTimeout(300);
            await expect(page).toHaveURL(/\/waiting-for$/);

            // Past the timeout the second key is just a key again.
            await page.keyboard.press('g');
            await page.waitForTimeout(1800);
            await expect(page.getByTestId('goToHint')).toHaveCount(0);
            await page.keyboard.press('n');
            await page.waitForTimeout(300);
            await expect(page).toHaveURL(/\/waiting-for$/);

            // In a text field, g is a letter.
            await page.goto('/next-actions');
            await page.getByTestId('nextActionsSearchButton').click();
            await page.getByTestId('nextActionsSearchInput').fill('');
            await page.keyboard.type('gi');
            await expect(page.getByTestId('nextActionsSearchInput')).toHaveValue('gi');
            await expect(page).toHaveURL(/\/next-actions/);
        });
    });

    test('on a focused list row, g d goes to Done — it never marks the row done; g c goes to Calendar, not copy-id', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `kb-goto-row-${dayjs().valueOf()}@example.com`, async (page) => {
            const [alpha] = await seedUndated(page, ['Alpha']);
            if (!alpha) throw new Error('seed');
            await page.goto('/next-actions');
            await page.waitForSelector('text=Alpha');

            await rowOf(page, 'Alpha').focus();
            await page.keyboard.press('g');
            await page.keyboard.press('c');
            await expect(page).toHaveURL(/\/calendar$/);
            // The `c` was the jump's — not quick capture's, not the row's copy-id.
            await expect(page.getByTestId('quickCaptureDialog')).toHaveCount(0);
            await expect(page.getByTestId('nextActionItemCopyIdButtonFeedback')).toHaveCount(0);
            await page.goBack();
            await page.waitForSelector('text=Alpha');
            await rowOf(page, 'Alpha').focus();
            await page.keyboard.press('g');
            await page.keyboard.press('d');
            await expect(page).toHaveURL(/\/done$/);
            expect((await gtd.listItems(page)).find((i) => i._id === alpha._id)?.status).toBe('nextAction');
        });
    });

    test('? opens the legend anywhere; / opens and focuses the list search; F6 / Shift+F6 cycle the regions', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `kb-f6-${dayjs().valueOf()}@example.com`, async (page) => {
            await seedUndated(page, ['Alpha']);
            await page.goto('/next-actions');
            await page.waitForSelector('text=Alpha');
            await page.locator('body').click();

            await page.keyboard.press('Shift+?');
            const legend = page.getByTestId('keyboardShortcutsDialog');
            await expect(legend).toBeVisible();
            await expect(legend).toContainText('g n');
            await expect(legend).toContainText('Next Actions');
            await page.keyboard.press('Escape');
            await expect(legend).toHaveCount(0);

            await page.keyboard.press('/');
            await expect(page.getByTestId('nextActionsSearchInput')).toBeFocused();
            // F6 works even from the text field — it is how a keyboard user leaves one.
            await page.keyboard.press('F6');
            await expect.poll(() => focusedRegion(page)).toBe('Main menu');
            await page.keyboard.press('F6');
            await expect.poll(() => focusedRegion(page)).toBe('Accounts');
            await page.keyboard.press('F6');
            await expect.poll(() => focusedRegion(page)).toBe('Filters');
            await page.keyboard.press('F6');
            await expect.poll(() => focusedRegion(page)).toBe('Next actions');
            await expect.poll(() => focused(page)).toBe('nextActionItemRow');
            await page.keyboard.press('F6'); // wraps
            await expect.poll(() => focusedRegion(page)).toBe('Main menu');
            await page.keyboard.press('Shift+F6');
            await expect.poll(() => focusedRegion(page)).toBe('Next actions');
        });
    });

    test('after a g jump the menu is entered on the page you are on, not on the link walked to before', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `kb-menu-entry-${dayjs().valueOf()}@example.com`, async (page) => {
            await page.goto('/next-actions');
            await page.waitForSelector('[data-testid="mainMenu"]');
            await page.locator('body').focus();
            await page.keyboard.press('Tab'); // the brand row's keyboard-shortcuts button
            await page.keyboard.press('Tab');
            await page.keyboard.press('ArrowDown'); // walk to Calendar, but do not follow it
            await expect.poll(() => focused(page)).toBe('Calendar');
            await page.locator('h5').first().click();
            await page.keyboard.press('g');
            await page.keyboard.press('w');
            await expect(page).toHaveURL(/\/waiting-for$/);
            await page.keyboard.press('F6');
            await expect.poll(() => focused(page)).toBe('Waiting For');
        });
    });

    test('a keyboard-pressed "+N more" chip unmounts itself; the filter bar stays reachable by Tab and Shift+Tab', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `kb-showmore-${dayjs().valueOf()}@example.com`, async (page) => {
            // More referenced contexts than the fold (8 + slack 2) so the row collapses behind "+N more".
            const contexts = [];
            for (let i = 1; i <= 12; i++) {
                contexts.push(await gtd.createWorkContext(page, `Ctx ${String(i).padStart(2, '0')}`));
            }
            await gtd.clarifyToNextAction(page, await gtd.collect(page, 'Tagged'), { workContextIds: contexts.map((c) => c._id) });
            await gtd.flush(page);
            await page.goto('/next-actions');
            await page.waitForSelector('text=Tagged');

            await page.getByTestId('nextActionsContextFilterChipShowMore').focus();
            await page.keyboard.press('Enter');
            await expect(page.getByTestId('nextActionsContextFilterChipShowMore')).toHaveCount(0);
            // Focus fell to the body with the chip; the region must still be a tab stop both ways.
            await page.getByTestId('nextActionsSearchButton').focus();
            await page.keyboard.press('Tab');
            await expect.poll(() => focusedRegion(page)).toBe('Filters');
            await page.keyboard.press('Tab');
            await expect.poll(() => focusedRegion(page)).toBe('Next actions');
            await page.keyboard.press('Shift+Tab');
            await expect.poll(() => focusedRegion(page)).toBe('Filters');
        });
    });

    test('F6 at a narrow (800 px) viewport cycles the visible regions and never sticks on the hidden drawer', async ({ browser }) => {
        await withOneLoggedInDevice(
            browser,
            `kb-f6-narrow-${dayjs().valueOf()}@example.com`,
            async (page) => {
                await seedUndated(page, ['Alpha']);
                await page.goto('/next-actions');
                await page.waitForSelector('text=Alpha');
                await page.locator('h5').first().click();
                const seen: string[] = [];
                for (let i = 0; i < 4; i++) {
                    await page.keyboard.press('F6');
                    await expect.poll(() => focusedRegion(page)).not.toBe('');
                    seen.push(await focusedRegion(page));
                }
                // The AppBar accounts, the filters and the list — no hidden drawer menu, and it keeps moving.
                expect(seen.slice(0, 3)).toEqual(['Accounts', 'Filters', 'Next actions']);
                expect(seen[3]).toBe('Accounts');
            },
            { viewport: { width: 800, height: 900 } },
        );
    });

    test('F6 under an open dialog leaves focus in the dialog; after a mouse click F6 lands on an item, not the bare container', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `kb-f6-modal-${dayjs().valueOf()}@example.com`, async (page) => {
            await seedUndated(page, ['Alpha']);
            await page.goto('/next-actions');
            await page.waitForSelector('text=Alpha');
            await page.locator('h5').first().click();
            await page.keyboard.press('Shift+?');
            const legend = page.getByTestId('keyboardShortcutsDialog');
            await expect(legend).toBeVisible();
            // F6 must not move focus out of the open dialog.
            const isInDialog = () => page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null);
            expect(await isInDialog()).toBe(true);
            await page.keyboard.press('F6');
            await page.waitForTimeout(200);
            expect(await isInDialog()).toBe(true);
            expect(await focusedRegion(page)).toBe('');
            await page.keyboard.press('Escape');

            // Mouse first, then the keyboard: the region still forwards into an item.
            // Clicked twice: the filter goes on (filtering energy-less Alpha out) and off again; focus ends on the chip by mouse.
            await page.getByTestId('nextActionsEnergyFilterChip').first().click();
            await page.getByTestId('nextActionsEnergyFilterChip').first().click();
            await expect(page).not.toHaveURL(/energy=/);
            // The first click left the empty state (no list region); the URL clears before the second click's render commits.
            await expect(page.locator('[data-keyboard-region][aria-label="Next actions"]')).toBeAttached();
            await page.keyboard.press('F6');
            await expect.poll(() => focusedRegion(page)).toBe('Next actions');
            await expect.poll(() => focused(page)).toBe('nextActionItemRow');
        });
    });

    test('with the "Show tags" switch focused, the letter shortcuts still work (a switch is not a text field)', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `kb-switch-${dayjs().valueOf()}@example.com`, async (page) => {
            await page.goto('/next-actions');
            await page.waitForSelector('[data-testid="mainMenu"]');
            await page.getByTestId('nextActionsShowTagsToggle').locator('input').focus();
            await page.keyboard.press('g');
            await page.keyboard.press('t');
            await expect(page).toHaveURL(/\/tickler$/);
        });
    });
});
