import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NextActionFields } from '../components/clarify/NextActionFields';
import styles from '../components/clarify/NextActionFields.module.css';
import type { NextActionFormState } from '../components/clarify/types';
import type { StoredPerson, StoredWorkContext } from '../types/MyDB';

// vitest runs in the node env, so there is no DOM to mount into. NextActionFields calls useMemo,
// which rules out invoking it as a plain function (the RowTags tests can, being hook-free) —
// renderToStaticMarkup runs the real hook machinery and hands back inspectable HTML.
const context = (id: string, name: string): StoredWorkContext => ({ _id: id, name, userId: 'u', createdTs: '', updatedTs: '' });
const person = (id: string, name: string): StoredPerson => ({ _id: id, name, userId: 'u', createdTs: '', updatedTs: '' });

const form: NextActionFormState = {
    workContextIds: [],
    peopleIds: [],
    energy: '',
    time: '',
    urgent: false,
    focus: false,
    expectedBy: '',
    ignoreBefore: '',
};

function markup(dense: boolean) {
    return renderToStaticMarkup(
        <NextActionFields value={form} onChange={() => {}} workContexts={[context('c1', '@phone')]} people={[person('p1', 'Dana')]} dense={dense} />,
    );
}

const TICKLER_EXPLAINER = 'Item stays hidden from Next Actions until this date';

describe('NextActionFields dense layout', () => {
    it('pairs the narrow controls into two columns above the sm breakpoint when dense', () => {
        // The grid IS the fix — without it every narrow control (date, number, toggle, checkbox
        // pair) keeps a full-width row, which is what forced scrolling in the weekly review.
        expect(markup(true)).toContain('grid-template-columns:1fr 1fr');
        expect(markup(false)).not.toContain('grid-template-columns');
    });

    it('spans the chip clouds across both grid columns when dense', () => {
        // Contexts and people genuinely use the full width — a half-width column would wrap them
        // more, costing back the vertical space the two-column grid just saved.
        const spans = markup(true).split(styles.fullSpan).length - 1;
        expect(spans).toBe(2);
    });

    it('leaves the chip clouds unspanned when not dense', () => {
        // Clarify and the standalone item editor share this component and must be untouched.
        expect(markup(false)).not.toContain(styles.fullSpan);
    });

    it('drops the tickler explainer line when dense', () => {
        // "Tickler — hide until" already carries the meaning; the second caption cost a full line
        // in a card that was already overflowing.
        expect(markup(false)).toContain(TICKLER_EXPLAINER);
        expect(markup(true)).not.toContain(TICKLER_EXPLAINER);
    });

    it('still renders every next-action control when dense', () => {
        // Density must not silently drop a field: the grid repositions controls, never removes them.
        const html = markup(true);
        expect(html).toContain('Tickler');
        expect(html).toContain('Work contexts');
        expect(html).toContain('People');
        expect(html).toContain('Energy');
        expect(html).toContain('Time estimate');
        expect(html).toContain('Urgent');
        expect(html).toContain('In focus');
        expect(html).toContain('Expected by');
    });
});
