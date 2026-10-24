import { expect, type Page, test } from '@playwright/test';
import { withOneLoggedInDevice, withTwoAccountsOnOneDevice } from './helpers/context';
import { PHONE } from './helpers/touch';
import { uniqueStamp } from './helpers/uniqueStamp';

// The design-system shell: the colour-scheme toggle (lib/colorScheme.ts stamps <html data-theme>,
// the tokens switch on it), the phone navigation drawer (Base UI Drawer, unmounted while closed), and
// the shell staying visible while the data layer settles at boot.

function stampedTheme(page: Page) {
    return page.evaluate(() => document.documentElement.getAttribute('data-theme'));
}

/** A token-driven colour: the page background, which --color-bg-page sets per scheme. */
function pageBackground(page: Page) {
    return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

test.describe('colour scheme', () => {
    test('Settings → Appearance flips <html data-theme> and the token colours, and the choice survives a reload', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `scheme-${uniqueStamp()}@example.com`, async (page) => {
            await page.emulateMedia({ colorScheme: 'light' });
            await page.goto('/settings');
            const appearance = page.getByRole('radiogroup', { name: 'Appearance' });
            await expect(appearance.getByRole('radio', { name: /System/ })).toBeChecked();
            expect(await stampedTheme(page)).toBe('light');
            const lightBackground = await pageBackground(page);

            await appearance.getByRole('radio', { name: 'Dark' }).click();
            await expect.poll(() => stampedTheme(page)).toBe('dark');
            expect(await pageBackground(page)).not.toBe(lightBackground);

            await page.reload();
            await expect(page.getByRole('radiogroup', { name: 'Appearance' }).getByRole('radio', { name: 'Dark' })).toBeChecked();
            expect(await stampedTheme(page)).toBe('dark');
        });
    });

    // The MUI bridge in __root.tsx mirrors the RESOLVED scheme into MUI; that must never come back
    // as the stored preference, or a System user would be pinned after a reload. Two guards hold it
    // (lib/colorScheme.ts adopts MUI's old key only once; MUI runs with storageManager={null}) —
    // this pins the behaviour, not either guard alone.
    test('System stays System across a reload and keeps following the OS', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `scheme-system-${uniqueStamp()}@example.com`, async (page) => {
            await page.emulateMedia({ colorScheme: 'light' });
            await page.goto('/settings');
            const appearance = page.getByRole('radiogroup', { name: 'Appearance' });
            await appearance.getByRole('radio', { name: 'Dark' }).click();
            await appearance.getByRole('radio', { name: /System/ }).click();
            await expect.poll(() => stampedTheme(page)).toBe('light');

            await page.reload();
            await expect(page.getByRole('radiogroup', { name: 'Appearance' }).getByRole('radio', { name: /System/ })).toBeChecked();
            await page.emulateMedia({ colorScheme: 'dark' });
            await expect.poll(() => stampedTheme(page)).toBe('dark');
        });
    });

    test('System follows the OS scheme while the page is open', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `scheme-os-${uniqueStamp()}@example.com`, async (page) => {
            await page.emulateMedia({ colorScheme: 'light' });
            await page.goto('/inbox');
            await expect.poll(() => stampedTheme(page)).toBe('light');
            await page.emulateMedia({ colorScheme: 'dark' });
            await expect.poll(() => stampedTheme(page)).toBe('dark');
        });
    });
});

test.describe('phone navigation drawer', () => {
    test('opens from the app bar, navigates, and closes; it is absent from the DOM while closed', async ({ browser }) => {
        await withOneLoggedInDevice(
            browser,
            `drawer-${uniqueStamp()}@example.com`,
            async (page) => {
                await page.goto('/inbox');
                const drawer = page.getByRole('dialog', { name: 'Navigation' });
                await expect(drawer).toHaveCount(0);

                await page.getByRole('button', { name: 'open navigation' }).click();
                await expect(drawer).toBeVisible();
                await drawer.getByRole('link', { name: 'People' }).click();
                await expect(page).toHaveURL(/\/people$/);
                await expect(drawer).toHaveCount(0);
            },
            PHONE,
        );
    });

    test('closes on Escape and from the bottom bar’s More button reopens', async ({ browser }) => {
        await withOneLoggedInDevice(
            browser,
            `drawer-esc-${uniqueStamp()}@example.com`,
            async (page) => {
                await page.goto('/inbox');
                await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'More' }).click();
                const drawer = page.getByRole('dialog', { name: 'Navigation' });
                await expect(drawer).toBeVisible();
                await page.keyboard.press('Escape');
                await expect(drawer).toHaveCount(0);
            },
            PHONE,
        );
    });
});

test.describe('boot', () => {
    // The multi-session seed adds the second account just after boot, which changes the data layer's
    // key. The provider defers that swap; adopted urgently it re-suspended to the boot boundary above
    // the shell, which flashed the whole shell hidden and dropped keyboard focus to <body>.
    test('the navigation never hides while the data layer settles on a two-account device', async ({ browser }) => {
        const stamp = uniqueStamp();
        await withTwoAccountsOnOneDevice(browser, [`shell-boot-a-${stamp}@example.com`, `shell-boot-b-${stamp}@example.com`], async (page) => {
            await page.addInitScript(watchNavVisibility);
            await page.goto('/next-actions');
            await expect.poll(() => page.evaluate(() => (window as NavWatchWindow).__navWatch?.isDone), { timeout: 10_000 }).toBe(true);
            expect(await page.evaluate(() => (window as NavWatchWindow).__navWatch?.hiddenAfterShown)).toBe(false);
        });
    });
});

type NavWatchWindow = Window & { __navWatch?: { hiddenAfterShown: boolean; isDone: boolean } };

/** Runs in the page from its first script: samples the sidebar menu every frame for 3s after it first shows. */
function watchNavVisibility() {
    const watch = { hiddenAfterShown: false, isDone: false };
    (window as NavWatchWindow).__navWatch = watch;
    let shownAt: number | null = null;
    const sample = (now: number) => {
        const menu = document.querySelector('[data-testid="mainMenu"]');
        const isVisible = menu?.checkVisibility() ?? false;
        if (shownAt === null && isVisible) shownAt = now;
        if (shownAt !== null && !isVisible) watch.hiddenAfterShown = true;
        if (shownAt !== null && now - shownAt > 3000) {
            watch.isDone = true;
            return;
        }
        requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
}
