import { describe, expect, it } from 'vitest';
import { nextWizardStep } from '../components/ProcessInboxWizard';
import type { StoredItem } from '../types/MyDB';

const ITEM_A: StoredItem = {
    _id: 'item-A',
    userId: 'user-1',
    status: 'inbox',
    title: 'A',
    createdTs: '2026-01-01T00:00:00.000Z',
    updatedTs: '2026-01-01T00:00:00.000Z',
};
const ITEM_B: StoredItem = { ...ITEM_A, _id: 'item-B', title: 'B' };
const ITEM_C: StoredItem = { ...ITEM_A, _id: 'item-C', title: 'C' };

// Locks in the wizard's progression contract — the body remounts on `${item._id}:${index}`,
// so any drift between `index` advancing and the items array would leave the body editing the
// wrong inbox item. The pure helper isolates the "what's the current step" decision so the
// rendering layer can stay dumb.
describe('nextWizardStep', () => {
    it('returns the first item with isLast=false on a multi-item list at index 0', () => {
        const step = nextWizardStep([ITEM_A, ITEM_B, ITEM_C], 0);
        expect(step).toEqual({ kind: 'item', index: 0, itemId: 'item-A', isLast: false });
    });

    it('marks isLast=true when at the final item — Save & finish vs Save & next branches off this', () => {
        const step = nextWizardStep([ITEM_A, ITEM_B, ITEM_C], 2);
        expect(step).toEqual({ kind: 'item', index: 2, itemId: 'item-C', isLast: true });
    });

    it('returns done when the index is past the last item', () => {
        const step = nextWizardStep([ITEM_A, ITEM_B], 2);
        expect(step).toEqual({ kind: 'done' });
    });

    it('returns done on an empty list — defensive: the route guards this earlier but the helper should be honest', () => {
        const step = nextWizardStep([], 0);
        expect(step).toEqual({ kind: 'done' });
    });

    it('marks the only item as isLast when there is exactly one', () => {
        const step = nextWizardStep([ITEM_A], 0);
        expect(step).toEqual({ kind: 'item', index: 0, itemId: 'item-A', isLast: true });
    });
});
