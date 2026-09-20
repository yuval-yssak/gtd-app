import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice } from './helpers/context';
import { gtd } from './helpers/gtd';

const CLARIFY_MODE_KEY = 'gtd:inlineClarifyMode';

// Page mode (full-screen edit at /item/:id) is read-mostly: it should not auto-focus the title
// (which would scroll the start of long titles out of view) and should default the notes section
// to a Markdown preview that switches to an editor on click. These tests pin the user-visible
// behaviour after the page-mode UX overhaul.
test.describe('Item editor — page mode UX', () => {
    test('does not auto-focus the title input on mount', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `page-no-autofocus-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'A very long title that would otherwise be clipped if the input scrolled to the cursor at the end');

            await page.goto(`/item/${item._id}`);
            await expect(page.getByRole('textbox', { name: 'Title' })).toBeVisible();

            // The title input must not own focus — auto-focus pins the cursor at the end of long
            // titles, scrolling the start out of view.
            const titleHasFocus = await page.evaluate(() => {
                const input = document.querySelector('input[type="text"]') as HTMLInputElement | null;
                return input !== null && document.activeElement === input;
            });
            expect(titleHasFocus).toBe(false);
        });
    });

    test('notes default to preview when non-empty; explicit Edit button switches to editor; blur returns to preview', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `page-notes-cycle-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Item with notes');
            await gtd.updateItem(page, { ...item, notes: 'Hello **world**' });

            await page.goto(`/item/${item._id}`);
            await expect(page.getByRole('textbox', { name: 'Title' })).toBeVisible();

            // Edit/Preview tabs should not appear in page mode — click-to-edit replaces them.
            await expect(page.getByRole('tab', { name: 'Edit' })).toHaveCount(0);
            await expect(page.getByRole('tab', { name: 'Preview' })).toHaveCount(0);

            // Preview rendered as Markdown — the bold word survives, the asterisks do not.
            const preview = page.getByTestId('pageNotesPreview');
            await expect(preview).toBeVisible();
            await expect(preview).toHaveAttribute('role', 'region');
            await expect(preview).toHaveAttribute('tabindex', '0');
            await expect(preview.locator('strong')).toHaveText('world');

            // aria-labelledby resolves to a real labelling element with the section caption text —
            // proves the labelId wiring (useId) survives client-side rendering on both ends.
            const labelId = await preview.getAttribute('aria-labelledby');
            expect(labelId).toBeTruthy();
            await expect(page.locator(`#${labelId}`)).toHaveText('Notes (Markdown)');

            // Clicking the explicit Edit affordance swaps to the CodeMirror editor and focuses it.
            await page.getByRole('button', { name: 'Edit notes' }).click();
            const notesEditor = page.getByRole('textbox', { name: 'Notes (Markdown)' });
            await expect(notesEditor).toBeVisible();
            await expect(notesEditor).toBeFocused();
            await expect(notesEditor).toHaveText('Hello **world**');

            // Blur: clicking the title input takes focus elsewhere; the editor returns to preview.
            await page.getByRole('textbox', { name: 'Title' }).click();
            await expect(page.getByTestId('pageNotesPreview')).toBeVisible();
        });
    });

    test('keyboard activation (Enter / Space) on the preview switches to the editor', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `page-notes-kbd-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Keyboard activation target');
            await gtd.updateItem(page, { ...item, notes: 'Initial content' });

            await page.goto(`/item/${item._id}`);
            const preview = page.getByTestId('pageNotesPreview');
            await expect(preview).toBeVisible();

            // Press Enter on the preview locator directly: locator.press auto-waits for the element
            // to be actionable and dispatches the key to it, so there's no separate focus() step to
            // race under load (a detached page.keyboard.press could land on the wrong element).
            await preview.press('Enter');
            const notesEditor = page.getByRole('textbox', { name: 'Notes (Markdown)' });
            // Gate on visible before focus — under load the editor's mount+autofocus lagged the keypress.
            // Generous timeout: the React mount can take several seconds under hook saturation.
            await expect(notesEditor).toBeVisible({ timeout: 15_000 });
            await expect(notesEditor).toBeFocused();

            // Blur back to preview, then verify Space also activates.
            await page.getByRole('textbox', { name: 'Title' }).click();
            const previewAgain = page.getByTestId('pageNotesPreview');
            await expect(previewAgain).toBeVisible();
            await previewAgain.press(' ');
            await expect(notesEditor).toBeVisible({ timeout: 15_000 });
            await expect(notesEditor).toBeFocused();
        });
    });

    test('clearing notes mid-edit and blurring keeps the editor visible (does not flip back to preview)', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `page-notes-clear-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Item with clearable notes');
            await gtd.updateItem(page, { ...item, notes: 'Clear me' });

            await page.goto(`/item/${item._id}`);
            // Wait for the Edit-notes affordance to be actionable before clicking — under hook
            // saturation the page hydrates slowly, so clicking too early was lost and the editor
            // never opened.
            const editNotesButton = page.getByRole('button', { name: 'Edit notes' });
            await expect(editNotesButton).toBeVisible();
            await editNotesButton.click();
            const notesEditor = page.getByRole('textbox', { name: 'Notes (Markdown)' });
            // Generous timeout: under full-suite saturation the React mount of the editor can take
            // several seconds. Then click into it to own focus deterministically — because the notes
            // are non-empty, a missed autofocus would collapse the editor back to preview before a
            // bare toBeFocused() settled; an explicit click removes that race and matches user intent.
            await expect(notesEditor).toBeVisible({ timeout: 15_000 });
            await notesEditor.click();
            await expect(notesEditor).toBeFocused();

            // Select-all + delete clears the field — once the value is empty, blur should NOT
            // collapse to a preview (there's nothing to preview, and the user is mid-flow).
            await notesEditor.fill('');
            await page.getByRole('textbox', { name: 'Title' }).click();
            await expect(page.getByRole('textbox', { name: 'Notes (Markdown)' })).toBeVisible();
            await expect(page.getByTestId('pageNotesPreview')).toHaveCount(0);
        });
    });

    test('typing into an empty editor and blurring collapses to preview (empty → non-empty → blur)', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `page-notes-empty-to-filled-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Item that gets notes');

            await page.goto(`/item/${item._id}`);
            const notesEditor = page.getByRole('textbox', { name: 'Notes (Markdown)' });
            await expect(notesEditor).toBeVisible();
            await expect(page.getByTestId('pageNotesPreview')).toHaveCount(0);

            // Type real content into the empty editor, then blur via the title input.
            await notesEditor.click();
            await notesEditor.fill('Now there are notes');
            await page.getByRole('textbox', { name: 'Title' }).click();

            // With non-empty notes, the editor should now collapse to a preview.
            await expect(page.getByTestId('pageNotesPreview')).toBeVisible();
            await expect(page.getByTestId('pageNotesPreview')).toContainText('Now there are notes');
        });
    });

    test('notes default to editor when empty (so the editing affordance is obvious) and does not steal focus on mount', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `page-notes-empty-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Item without notes');

            await page.goto(`/item/${item._id}`);
            await expect(page.getByRole('textbox', { name: 'Title' })).toBeVisible();

            // No preview region rendered when there are no notes — the editor is shown directly.
            await expect(page.getByTestId('pageNotesPreview')).toHaveCount(0);
            const notesEditor = page.getByRole('textbox', { name: 'Notes (Markdown)' });
            await expect(notesEditor).toBeVisible();

            // The editor must NOT auto-focus on initial mount — the same complaint that motivated
            // removing title autofocus would otherwise just move one field down.
            await expect(notesEditor).not.toBeFocused();
        });
    });

    test('page-mode wrapper renders at the wider 56rem cap on a wide viewport', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `page-width-${dayjs().valueOf()}@example.com`, async (page) => {
            // Use a wide viewport so the cap, not the viewport, governs the wrapper width.
            await page.setViewportSize({ width: 1600, height: 900 });
            const item = await gtd.collect(page, 'Wrapper width check');

            await page.goto(`/item/${item._id}`);
            await expect(page.getByTestId('itemPageWrapper')).toBeVisible();

            // 56rem at the default 16px root font size = 896px. Allow a small fudge for sub-pixel
            // rounding but stay tight enough to catch a regression to the old 35rem (560px) cap.
            const wrapperWidth = await page.evaluate(() => {
                const el = document.querySelector('[data-testid="itemPageWrapper"]') as HTMLElement | null;
                return el ? el.getBoundingClientRect().width : 0;
            });
            expect(wrapperWidth).toBeGreaterThanOrEqual(880);
            expect(wrapperWidth).toBeLessThanOrEqual(900);
        });
    });

    test('ESC navigates back to the originating list', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `page-esc-back-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Escape target');

            await page.goto('/inbox');
            await page.waitForSelector('text=Escape target');
            await page.evaluate(
                (args) => {
                    localStorage.setItem(args.key, 'page');
                    window.dispatchEvent(new StorageEvent('storage', { key: args.key, newValue: 'page' }));
                },
                { key: CLARIFY_MODE_KEY },
            );

            // In-app navigation (row click) so the router has history for ESC's history-back path.
            await page.getByText('Escape target').click();
            await expect(page).toHaveURL(new RegExp(`/item/${item._id}`));
            // Gate on the editor being mounted — the ESC listener attaches in an effect, so a
            // keypress fired on the bare URL change can land before anyone is listening.
            await expect(page.getByRole('textbox', { name: 'Title' })).toBeVisible();

            await page.keyboard.press('Escape');
            await expect(page).toHaveURL(/\/inbox/);

            // Leaving via ESC pushes the list (rather than popping history), so the edited
            // item stays in the stack — the browser Back button returns to it.
            await page.goBack();
            await expect(page).toHaveURL(new RegExp(`/item/${item._id}`));
        });
    });

    test('ESC closes an open Select popup first; second ESC leaves the page', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `page-esc-select-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Escape with popup');
            // Pre-set waitingFor so the person Select is on the page without a structural edit
            // (which would put the second ESC behind the unsaved-changes guard).
            await gtd.updateItem(page, { ...item, status: 'waitingFor' });

            await page.goto(`/item/${item._id}`);
            await page.getByLabel('Waiting for (optional)').click();
            await expect(page.getByRole('listbox')).toBeVisible();

            // First ESC: MUI closes the menu, the page listener stands down — URL unchanged.
            await page.keyboard.press('Escape');
            await expect(page.getByRole('listbox')).toHaveCount(0);
            // Wait out the menu's exit transition — the page listener treats a still-open (not yet
            // aria-hidden/unmounted) MuiModal-root as "popup open" and would swallow the second ESC.
            // AppNav's keep-mounted mobile drawer stays in the DOM aria-hidden, hence the :not().
            await expect(page.locator('.MuiModal-root:not([aria-hidden="true"])')).toHaveCount(0);
            await expect(page).toHaveURL(new RegExp(`/item/${item._id}`));

            // Second ESC: nothing open → navigate back (deep link → status-bucket fallback).
            await page.keyboard.press('Escape');
            await expect(page).toHaveURL(/\/waiting-for/);
        });
    });

    test('ESC in the notes editor returns to preview first; second ESC leaves the page', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `page-esc-notes-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Escape from notes');
            await gtd.updateItem(page, { ...item, notes: 'Some notes' });

            await page.goto(`/item/${item._id}`);
            const editNotesButton = page.getByRole('button', { name: 'Edit notes' });
            await expect(editNotesButton).toBeVisible();
            await editNotesButton.click();
            const notesEditor = page.getByRole('textbox', { name: 'Notes (Markdown)' });
            await expect(notesEditor).toBeVisible({ timeout: 15_000 });

            // First ESC (in the editor): steps out to the preview, does not navigate.
            await notesEditor.press('Escape');
            await expect(page.getByTestId('pageNotesPreview')).toBeVisible();
            await expect(page).toHaveURL(new RegExp(`/item/${item._id}`));

            // Second ESC: nothing claims it → navigate back (deep link → inbox fallback).
            await page.keyboard.press('Escape');
            await expect(page).toHaveURL(/\/inbox/);
        });
    });

    test('honours mode setting end-to-end: clicking a row in page mode navigates to /item/:id', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `page-mode-nav-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Nav target');

            await page.goto('/inbox');
            await page.waitForSelector('text=Nav target');

            await page.evaluate(
                (args) => {
                    localStorage.setItem(args.key, 'page');
                    window.dispatchEvent(new StorageEvent('storage', { key: args.key, newValue: 'page' }));
                },
                { key: CLARIFY_MODE_KEY },
            );

            await page.getByText('Nav target').click();
            await expect(page).toHaveURL(new RegExp(`/item/${item._id}`));
        });
    });

    test('clicking a link in the notes preview opens it in a new tab and stays in preview', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `page-notes-link-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Item with a linked note');
            await gtd.updateItem(page, { ...item, notes: 'See [the docs](https://example.com/docs) for details' });
            // Hermetic: the new tab never leaves the test machine. Registered on the context so the
            // popup tab is covered too.
            await page.context().route('https://example.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>docs</h1>' }));

            await page.goto(`/item/${item._id}`);
            const preview = page.getByTestId('pageNotesPreview');
            await expect(preview).toBeVisible();
            const link = preview.getByRole('link', { name: 'the docs' });
            await expect(link).toHaveAttribute('target', '_blank');
            await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
            const notesEditor = page.getByRole('textbox', { name: 'Notes (Markdown)' });

            // Plain click: opens a new tab, and the preview must NOT flip into the editor.
            const plainClickTab = page.context().waitForEvent('page');
            await link.click();
            await expect(await plainClickTab).toHaveURL(/example\.com\/docs/);
            await expect(preview).toBeVisible();
            await expect(notesEditor).toHaveCount(0);

            // cmd+click: same outcome — the modifier gesture must not leak into an edit-mode switch either.
            const modifierClickTab = page.context().waitForEvent('page');
            await link.click({ modifiers: ['Meta'] });
            await expect(await modifierClickTab).toHaveURL(/example\.com\/docs/);
            await expect(preview).toBeVisible();
            await expect(notesEditor).toHaveCount(0);

            // Enter on a focused link is the browser's own activation — it opens, the preview stays.
            await link.focus();
            const keyboardTab = page.context().waitForEvent('page');
            await link.press('Enter');
            await expect(await keyboardTab).toHaveURL(/example\.com\/docs/);
            await expect(preview).toBeVisible();
            await expect(notesEditor).toHaveCount(0);
        });
    });

    test('Space on a focused link inside the preview enters edit mode without scroll-jumping the page', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `page-notes-link-space-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Item with a linked note and a tall page');
            // Enough trailing lines that the document scrolls, so a leaked default Space would move it.
            const tail = Array.from({ length: 80 }, (_, i) => `Filler ${i + 1}`).join('\n\n');
            await gtd.updateItem(page, { ...item, notes: `See [the docs](https://example.com/docs) for details\n\n${tail}` });

            await page.goto(`/item/${item._id}`);
            const preview = page.getByTestId('pageNotesPreview');
            await expect(preview).toBeVisible();
            const link = preview.getByRole('link', { name: 'the docs' });
            await link.focus();

            // Anchors do not activate on Space, so the key belongs to the region: no new tab, no
            // scroll, but the editor opens (as it does for Space on the region itself).
            const scrollBefore = await page.evaluate(() => window.scrollY);
            await link.press(' ');
            await expect(page.getByRole('textbox', { name: 'Notes (Markdown)' })).toBeVisible({ timeout: 15_000 });
            expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
            expect(page.context().pages()).toHaveLength(1);
        });
    });

    test('clicking prose next to a link still enters edit mode (the carve-out is link-only)', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `page-notes-prose-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Item with a linked note and prose');
            await gtd.updateItem(page, { ...item, notes: 'See [the docs](https://example.com/docs) for details' });

            await page.goto(`/item/${item._id}`);
            const preview = page.getByTestId('pageNotesPreview');
            await expect(preview).toBeVisible();
            await preview.getByText('for details').click();
            await expect(page.getByRole('textbox', { name: 'Notes (Markdown)' })).toBeVisible({ timeout: 15_000 });
            expect(page.context().pages()).toHaveLength(1);
        });
    });

    test('very long notes scroll inside a capped preview and the bottom of the editor stays reachable', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `page-notes-long-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Item with very long notes');
            const longNotes = Array.from({ length: 200 }, (_, i) => `Line ${i + 1} of a very long note`).join('\n\n');
            await gtd.updateItem(page, { ...item, notes: longNotes });

            await page.goto(`/item/${item._id}`);
            const preview = page.getByTestId('pageNotesPreview');
            await expect(preview).toBeVisible();
            await expect(preview).toContainText('Line 200');

            // Read the cap from its single source of truth (index.css) instead of a magic 0.6.
            const capVh = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gtd-notes-max-height')));
            const viewport = page.viewportSize();
            const previewBox = await preview.boundingBox();
            if (!viewport || !previewBox || Number.isNaN(capVh)) throw new Error('expected a viewport, a preview box and a vh cap');
            // Capped (2px of tolerance for border rounding) but not collapsed.
            expect(previewBox.height).toBeLessThanOrEqual((viewport.height * capVh) / 100 + 2);
            expect(previewBox.height).toBeGreaterThan(200);
            // The overflow lives inside the preview...
            const scrollsInternally = await preview.evaluate((el) => el.scrollHeight > el.clientHeight);
            expect(scrollsInternally).toBe(true);
            // ...so the reported symptom is gone: the bottom of the editor is one page-scroll away.
            const bottomMeta = page.getByTestId('itemEditorId');
            await bottomMeta.scrollIntoViewIfNeeded();
            await expect(bottomMeta).toBeInViewport();
        });
    });

    test('calendar item renders date/time fields between the title and the notes', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `page-cal-order-${dayjs().valueOf()}@example.com`, async (page) => {
            const captured = await gtd.collect(page, 'Dentist appointment');
            const calItem = await gtd.clarifyToCalendar(page, captured, { timeStart: '2026-09-01T10:00:00', timeEnd: '2026-09-01T10:30:00' });
            await gtd.updateItem(page, { ...calItem, notes: 'Bring the referral letter' });
            await gtd.flush(page); // never navigate mid-flush — see clarify-to-routine.spec.ts

            await page.goto(`/item/${calItem._id}`);
            await expect(page.getByRole('textbox', { name: 'Title' })).toBeVisible();

            const titleBox = await page.getByRole('textbox', { name: 'Title' }).boundingBox();
            const dateBox = await page.getByTestId('allDayToggle').boundingBox();
            const notesBox = await page.getByTestId('pageNotesPreview').boundingBox();
            if (!titleBox || !dateBox || !notesBox) throw new Error('expected title, date-toggle, and notes boxes');
            // Date/time block sits below the title but ABOVE the notes for calendar items.
            expect(dateBox.y).toBeGreaterThan(titleBox.y);
            expect(dateBox.y).toBeLessThan(notesBox.y);
        });
    });
});
