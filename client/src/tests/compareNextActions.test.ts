import { describe, expect, it } from 'vitest';
import { compareNextActions } from '../lib/compareNextActions';
import type { StoredItem } from '../types/MyDB';

function makeItem(overrides: Partial<StoredItem> & { _id: string }): StoredItem {
    return {
        userId: 'user-1',
        status: 'nextAction',
        title: overrides._id,
        createdTs: '2026-01-01T00:00:00.000Z',
        updatedTs: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

// The comparator is a shared contract between the Next Actions page and the weekly-review
// wizard — both must present the exact same order, so its tie semantics are load-bearing.
describe('compareNextActions', () => {
    it('returns 0 for same-tier undated items so a stable sort preserves input order', () => {
        const a = makeItem({ _id: 'a' });
        const b = makeItem({ _id: 'b' });
        expect(compareNextActions(a, b)).toBe(0);
        // Ties are deliberately delegated to input order — both consumers feed the same
        // items array, which is what keeps the page and the wizard identical.
        expect([b, a].sort(compareNextActions).map((item) => item._id)).toEqual(['b', 'a']);
    });

    it('treats focus: false and absent focus as the same tier', () => {
        const explicit = makeItem({ _id: 'explicit', focus: false, expectedBy: '2026-09-01' });
        const absent = makeItem({ _id: 'absent', expectedBy: '2026-09-02' });
        expect([absent, explicit].sort(compareNextActions).map((item) => item._id)).toEqual(['explicit', 'absent']);
    });

    it('treats an empty-string expectedBy as undated', () => {
        const empty = makeItem({ _id: 'empty', expectedBy: '' });
        const dated = makeItem({ _id: 'dated', expectedBy: '2026-09-01' });
        expect([empty, dated].sort(compareNextActions).map((item) => item._id)).toEqual(['dated', 'empty']);
    });

    it('orders the four tiers: focus+date, focus undated, plain+date, plain undated', () => {
        const focusDated = makeItem({ _id: 'focusDated', focus: true, expectedBy: '2026-09-01' });
        const focusUndated = makeItem({ _id: 'focusUndated', focus: true });
        const plainDated = makeItem({ _id: 'plainDated', expectedBy: '2026-08-01' });
        const plainUndated = makeItem({ _id: 'plainUndated' });
        const sorted = [plainUndated, plainDated, focusUndated, focusDated].sort(compareNextActions);
        expect(sorted.map((item) => item._id)).toEqual(['focusDated', 'focusUndated', 'plainDated', 'plainUndated']);
    });
});
