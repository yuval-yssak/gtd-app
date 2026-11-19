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
    expectedBy: '',
    ignoreBefore: '',
};

function markup() {
    return renderToStaticMarkup(<NextActionFields value={form} onChange={() => {}} workContexts={[context('c1', '@phone')]} people={[person('p1', 'Dana')]} />);
}

const TICKLER_EXPLAINER = 'Item stays hidden from Next Actions until this date';

// One layout for the item page and the weekly review alike: the narrow controls flow into a grid
// (the geometry is pinned by e2e/weekly-review-dense-fields.spec.ts; below 34rem a container query
// keeps the single column).
describe('NextActionFields grid layout', () => {
    it("is a size container, so the grid can key off the fields' own width", () => {
        expect(markup()).toContain(styles.root);
    });

    it('spans the chip clouds across every grid column', () => {
        // Contexts and people genuinely use the full width — a one-column cell would wrap them
        // more, costing back the vertical space the grid just saved.
        const spans = markup().split(styles.fullSpan).length - 1;
        expect(spans).toBe(2);
    });

    it('has no tickler explainer line — "Tickler — hide until" already carries the meaning', () => {
        expect(markup()).not.toContain(TICKLER_EXPLAINER);
    });

    it('still renders every next-action control', () => {
        // Density must not silently drop a field: the grid repositions controls, never removes them.
        const html = markup();
        expect(html).toContain('Tickler');
        expect(html).toContain('Work contexts');
        expect(html).toContain('People');
        expect(html).toContain('Energy');
        expect(html).toContain('Time estimate');
        expect(html).toContain('Urgent');
        // The "In focus" checkbox is gone: priority is the drag order on the Next Actions page.
        expect(html).not.toContain('In focus');
        expect(html).toContain('Expected by');
    });
});
