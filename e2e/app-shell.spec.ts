import { expect, type Page, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { PHONE } from './helpers/touch';

// The design-system shell: the colour-scheme toggle (lib/colorScheme.ts stamps <html data-theme>,
// the tokens switch on it) and the phone navigation drawer (Base UI Drawer, unmounted while closed).

function stampedTheme(page: Page) {
    return page.evaluate(() => document.documentElement.getAttribute('data-theme'));
}

/** A token-driven colour: the page background, which --color-bg-page sets per scheme. */
function pageBackground(page: Page) {
    return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

test.describe('colour scheme', () => {
    test('Settings → Appearance flips <html data-theme> and the token colours, and the choice survives a reload', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `scheme-${dayjs().valueOf()}@example.com`, async (page) => {
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
        await withOneLoggedInDevice(browser, `scheme-system-${dayjs().valueOf()}@example.com`, async (page) => {
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
        await withOneLoggedInDevice(browser, `scheme-os-${dayjs().valueOf()}@example.com`, async (page) => {
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
            `drawer-${dayjs().valueOf()}@example.com`,
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
            `drawer-esc-${dayjs().valueOf()}@example.com`,
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
