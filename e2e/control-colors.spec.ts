import { expect, type Locator, type Page, test } from '@playwright/test';
import { withOneLoggedInDevice } from './helpers/context';
import { uniqueStamp } from './helpers/uniqueStamp';

// Enabled icon buttons (the review's ◀ ▶ « », row actions) and the sidebar's menu items rest in
// the control text colour — not the secondary grey that read as "disabled" — and brighten to the
// primary text colour on hover.

async function tokenColor(page: Page, token: string): Promise<string> {
    // Resolve the token through a probe element so the comparison is in the browser's rgb() form.
    return page.evaluate((name) => {
        const probe = document.createElement('span');
        probe.style.color = `var(${name})`;
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
    }, token);
}

const colorOf = (locator: Locator) => locator.evaluate((element) => getComputedStyle(element).color);

test.describe('control colours', () => {
    test('review icon buttons and sidebar menu items rest in the control colour and brighten on hover', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `control-colors-${uniqueStamp()}@example.com`, async (page) => {
            await page.goto('/weekly-review');
            await page.getByTestId('startReviewButton').click();
            const nextStage = page.getByTestId('stageTravelNext');
            await expect(nextStage).toBeEnabled();

            const control = await tokenColor(page, '--color-text-control');
            const secondary = await tokenColor(page, '--color-text-secondary');
            const primary = await tokenColor(page, '--color-text-primary');
            expect(control).not.toBe(secondary);
            expect(control).not.toBe(primary);

            await page.mouse.move(0, 0);
            await expect.poll(() => colorOf(nextStage)).toBe(control);
            await nextStage.hover();
            await expect.poll(() => colorOf(nextStage)).toBe(primary);

            const inboxLink = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Inbox' });
            await page.mouse.move(0, 0);
            await expect.poll(() => colorOf(inboxLink)).toBe(control);
            await inboxLink.hover();
            await expect.poll(() => colorOf(inboxLink)).toBe(primary);
        });
    });
});
