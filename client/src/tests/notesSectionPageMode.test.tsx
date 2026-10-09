/** Page-mode NotesSection resting states: non-empty notes rest in a read-only preview with the
 *  pencil as the only way into the editor; empty notes rest in the editor with "Done" disabled.
 *  Rendered with renderToStaticMarkup (no DOM in this test environment). */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NotesSection } from '../components/itemEditor/NotesSection';

const noop = () => {};

function renderPageNotes(notes: string) {
    return renderToStaticMarkup(<NotesSection notes={notes} onNotesChange={noop} chrome="page" />);
}

/** The opening tag of the button carrying `label`, so attribute checks stay scoped to it. */
function buttonTag(html: string, label: string) {
    return html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0];
}

describe('NotesSection page mode', () => {
    it('non-empty notes rest in a read-only preview with the pencil as the only edit affordance', () => {
        const html = renderPageNotes('Hello **world**');
        expect(html).toMatch(/<div[^>]*role="region"[^>]*data-testid="pageNotesPreview"/);
        expect(html).toContain('<strong>world</strong>');
        expect(buttonTag(html, 'Edit notes')).toBeDefined();
        expect(buttonTag(html, 'Done editing notes')).toBeUndefined();
    });

    it('empty notes rest in the editor with Done disabled (nothing to preview yet)', () => {
        const html = renderPageNotes('   ');
        expect(html).not.toContain('pageNotesPreview');
        expect(buttonTag(html, 'Edit notes')).toBeUndefined();
        expect(buttonTag(html, 'Done editing notes')).toMatch(/\sdisabled=""/);
    });
});
