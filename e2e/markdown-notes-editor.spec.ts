import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';
import { withOneLoggedInDevice, withTwoLoggedInDevices } from './helpers/context';
import { gtd } from './helpers/gtd';

const GFM_NOTES = [
    '| col a | col b |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    'some ~~gone~~ text',
    '',
    '- [x] done thing',
    '',
    '```ts',
    'const x = 1;',
    '```',
].join('\n');

// The notes editor is CodeMirror 6 with GFM markdown (tables, strikethrough, task lists, fenced
// code) and the preview renders the same dialect via remark-gfm. These tests pin the advanced
// markdown path end to end: stored notes → preview HTML, and editor → preview roundtrip.
test.describe('Markdown notes editor — GFM + editor behaviours', () => {
    test('preview renders GFM: table, strikethrough, task list checkbox and highlighted code fence', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `gfm-preview-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'GFM preview item');
            await gtd.updateItem(page, { ...item, notes: GFM_NOTES });

            await page.goto(`/item/${item._id}`);
            const preview = page.getByTestId('pageNotesPreview');
            await expect(preview).toBeVisible();

            // Table: header cell + body cell rendered as a real table, not literal pipes.
            await expect(preview.locator('table th').first()).toHaveText('col a');
            await expect(preview.locator('table td').first()).toHaveText('1');
            // Strikethrough → <del>; task list → checkbox input; fenced code → <pre><code>.
            await expect(preview.locator('del')).toHaveText('gone');
            await expect(preview.locator('input[type="checkbox"]')).toBeChecked();
            await expect(preview.locator('pre code')).toContainText('const x = 1;');
        });
    });

    test('editing GFM notes in the CodeMirror editor updates the preview on blur', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `gfm-roundtrip-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'GFM roundtrip item');

            await page.goto(`/item/${item._id}`);
            // Empty notes → editor is the resting state.
            const notesEditor = page.getByRole('textbox', { name: 'Notes (Markdown)' });
            await expect(notesEditor).toBeVisible({ timeout: 15_000 });
            await notesEditor.click();
            await notesEditor.fill('| h |\n| --- |\n| cell |\n\nand ~~struck~~ text');

            // Blur via the title input collapses to preview, which must render the GFM table.
            await page.getByRole('textbox', { name: 'Title' }).click();
            const preview = page.getByTestId('pageNotesPreview');
            await expect(preview).toBeVisible();
            await expect(preview.locator('table th')).toHaveText('h');
            await expect(preview.locator('table td')).toHaveText('cell');
            await expect(preview.locator('del')).toHaveText('struck');
        });
    });

    test('markdown syntax is highlighted while typing (heading gets a distinct style)', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `gfm-highlight-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Highlight item');

            await page.goto(`/item/${item._id}`);
            const notesEditor = page.getByRole('textbox', { name: 'Notes (Markdown)' });
            await expect(notesEditor).toBeVisible({ timeout: 15_000 });
            await notesEditor.click();
            await notesEditor.fill('# Heading\n\nplain');

            // The heading text is wrapped in a styled span (font-weight 700 per the highlight
            // style) — proves live syntax highlighting is active, without pinning class names.
            const headingWeight = await page.evaluate(() => {
                const spans = Array.from(document.querySelectorAll('[data-testid="markdownNotesEditor"] .cm-line span'));
                // The heading text span is " Heading" — CodeMirror puts the "#" mark in its own span.
                const heading = spans.find((s) => s.textContent?.trim() === 'Heading');
                return heading ? getComputedStyle(heading).fontWeight : null;
            });
            expect(headingWeight).toBe('700');
        });
    });

    test('find panel: Mod-F opens search inside the editor; Escape closes it without leaving the editor', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `gfm-search-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Search item');
            await gtd.updateItem(page, { ...item, notes: 'needle in some text, needle again' });

            await page.goto(`/item/${item._id}`);
            await page.getByRole('button', { name: 'Edit notes' }).click();
            const notesEditor = page.getByRole('textbox', { name: 'Notes (Markdown)' });
            await expect(notesEditor).toBeVisible({ timeout: 15_000 });
            await notesEditor.click();

            await page.keyboard.press('ControlOrMeta+f');
            const searchField = page.locator('.cm-panel.cm-search input[name="search"]');
            await expect(searchField).toBeVisible();
            // pressSequentially, not fill: the panel commits the query on keyup, which fill skips.
            await searchField.pressSequentially('needle');
            await expect(page.locator('.cm-searchMatch')).toHaveCount(2);

            // Escape while the panel is open closes the panel — the editor must stay in edit mode
            // (the panel's Escape wins over the exit-to-preview Escape).
            await page.keyboard.press('Escape');
            await expect(searchField).toHaveCount(0);
            await expect(notesEditor).toBeVisible();
            await expect(page.getByTestId('pageNotesPreview')).toHaveCount(0);
        });
    });

    test('a remote live-merge into the open editor preserves the caret position', async ({ browser }) => {
        const email = `gfm-caret-${dayjs().valueOf()}@example.com`;
        await withTwoLoggedInDevices(browser, email, async (page1, page2) => {
            const item = await gtd.collect(page1, 'Caret target');
            await gtd.updateItem(page1, { ...item, notes: 'hello world' });
            await gtd.flush(page1);
            await gtd.pull(page2);

            await page1.goto(`/item/${item._id}`);
            await page1.getByRole('button', { name: 'Edit notes' }).click();
            const notesEditor = page1.getByRole('textbox', { name: 'Notes (Markdown)' });
            await expect(notesEditor).toBeVisible({ timeout: 15_000 });
            await notesEditor.click();
            await page1.keyboard.press('End'); // caret at offset 11, end of 'hello world'

            // Device 2 extends the notes while device 1's editor sits open and clean.
            const onDevice2 = (await gtd.listItems(page2)).find((i) => i._id === item._id);
            if (!onDevice2) throw new Error('item did not reach device 2');
            await gtd.updateItem(page2, { ...onDevice2, notes: 'hello world and more' });
            await gtd.flush(page2);

            // SSE → pull → live merge replaces the doc externally; the caret must stay at 11,
            // not collapse to 0 (a whole-doc dispatch without an explicit selection does that).
            await expect(notesEditor).toHaveText('hello world and more', { timeout: 15_000 });
            const caretOffset = await page1.evaluate(() => {
                const selection = document.getSelection();
                const content = document.querySelector('[data-testid="markdownNotesEditor"] .cm-content');
                if (!selection || selection.rangeCount === 0 || !content) {
                    return -1;
                }
                const caret = selection.getRangeAt(0);
                const fromStart = caret.cloneRange();
                fromStart.selectNodeContents(content);
                fromStart.setEnd(caret.startContainer, caret.startOffset);
                return fromStart.toString().length;
            });
            expect(caretOffset).toBe(11);
        });
    });

    test('multi-cursor: Mod-D selects the next occurrence and typing edits both', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `gfm-multicursor-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'Multi-cursor item');

            await page.goto(`/item/${item._id}`);
            const notesEditor = page.getByRole('textbox', { name: 'Notes (Markdown)' });
            await expect(notesEditor).toBeVisible({ timeout: 15_000 });
            await notesEditor.click();
            await page.keyboard.type('foo bar foo');

            // Select the first "foo" with the keyboard (deterministic, unlike double-click),
            // then Mod-D adds the second occurrence as another selection range.
            await page.keyboard.press('Home');
            for (let i = 0; i < 3; i++) {
                await page.keyboard.press('Shift+ArrowRight');
            }
            await page.keyboard.press('ControlOrMeta+d');
            await page.keyboard.type('baz');

            await expect(notesEditor).toHaveText('baz bar baz');
        });
    });

    test('pressing Enter inside a list continues the list marker (editor keymap)', async ({ browser }) => {
        await withOneLoggedInDevice(browser, `gfm-list-continue-${dayjs().valueOf()}@example.com`, async (page) => {
            const item = await gtd.collect(page, 'List continuation item');

            await page.goto(`/item/${item._id}`);
            const notesEditor = page.getByRole('textbox', { name: 'Notes (Markdown)' });
            await expect(notesEditor).toBeVisible({ timeout: 15_000 });
            await notesEditor.click();
            await page.keyboard.type('- first');
            await page.keyboard.press('Enter');
            await page.keyboard.type('second');

            const lines = page.locator('[data-testid="markdownNotesEditor"] .cm-line');
            await expect(lines).toHaveCount(2);
            // The markdown keymap auto-inserted the "- " marker on the new line.
            await expect(lines.nth(1)).toHaveText('- second');
        });
    });
});
