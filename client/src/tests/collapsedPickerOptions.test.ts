import { describe, expect, it } from 'vitest';
import { collapsePickerOptions, isPickerCollapsible, PICKER_COLLAPSE_LIMIT } from '../lib/collapsedPickerOptions';

interface Opt {
    _id: string;
}

const keyOf = (o: Opt) => o._id;
const opts = (ids: string[]): Opt[] => ids.map((_id) => ({ _id }));

function collapse(rankedIds: string[], overrides: Partial<Parameters<typeof collapsePickerOptions<Opt>>[0]> = {}) {
    const ranked = opts(rankedIds);
    const alphabetical = opts([...rankedIds].sort());
    return collapsePickerOptions<Opt>({ ranked, alphabetical, selectedIds: new Set(), keyOf, expanded: false, ...overrides });
}

const manyIds = Array.from({ length: 15 }, (_, i) => `id${String(i).padStart(2, '0')}`);

describe('collapsePickerOptions', () => {
    it('shows short lists in full, A→Z, with no expander', () => {
        const { visible, hiddenCount } = collapse(['c', 'a', 'b']);
        expect(visible.map(keyOf)).toEqual(['a', 'b', 'c']);
        expect(hiddenCount).toBe(0);
    });

    it('does not collapse a list only slightly over the limit (slack)', () => {
        const ids = manyIds.slice(0, PICKER_COLLAPSE_LIMIT + 2);
        expect(collapse(ids).hiddenCount).toBe(0);
    });

    it('collapses long lists to the top-ranked slice', () => {
        const { visible, hiddenCount } = collapse(manyIds);
        expect(visible.map(keyOf)).toEqual(manyIds.slice(0, PICKER_COLLAPSE_LIMIT));
        expect(hiddenCount).toBe(manyIds.length - PICKER_COLLAPSE_LIMIT);
    });

    it('keeps selected options visible even when ranked below the fold', () => {
        const selected = manyIds[manyIds.length - 1];
        if (!selected) throw new Error('expected a last id');
        const { visible, hiddenCount } = collapse(manyIds, { selectedIds: new Set([selected]) });
        expect(visible.map(keyOf)).toContain(selected);
        expect(hiddenCount).toBe(manyIds.length - PICKER_COLLAPSE_LIMIT - 1);
    });

    it('expanded shows everything alphabetically', () => {
        const { visible, hiddenCount } = collapse(manyIds, { expanded: true });
        expect(visible.map(keyOf)).toEqual([...manyIds].sort());
        expect(hiddenCount).toBe(0);
    });
});

describe('isPickerCollapsible', () => {
    it('is false at the slack boundary and true past it', () => {
        expect(isPickerCollapsible(PICKER_COLLAPSE_LIMIT + 2)).toBe(false);
        expect(isPickerCollapsible(PICKER_COLLAPSE_LIMIT + 3)).toBe(true);
    });

    it('a list that shrinks below the threshold while expanded shows everything with no fold', () => {
        // Simulates live-faceting removing options underneath an open expansion — the "Show fewer"
        // chip is gated on isPickerCollapsible, so this state must render fold-free.
        const shrunkIds = manyIds.slice(0, 5);
        const { visible, hiddenCount } = collapse(shrunkIds, { expanded: true });
        expect(visible.map(keyOf)).toEqual([...shrunkIds].sort());
        expect(hiddenCount).toBe(0);
        expect(isPickerCollapsible(shrunkIds.length)).toBe(false);
    });
});
