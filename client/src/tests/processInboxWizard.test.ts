import { describe, expect, it } from 'vitest';
import { nextWizardStep, runSummaryNotice } from '../components/ProcessInboxWizard';
import { FROM_GMAIL_READONLY_MESSAGE } from '../db/itemMutations';
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

describe('runSummaryNotice', () => {
    it('says the inbox is clear when every item of the run was saved, singular or plural', () => {
        expect(runSummaryNotice({ total: 3, skipped: 0 }, false)).toBe('Inbox clear! All 3 items processed.');
        expect(runSummaryNotice({ total: 1, skipped: 0 }, false)).toBe('Inbox clear! All 1 item processed.');
    });

    // The run lands back on the inbox, where skipped items are plainly still listed — so the
    // summary must not claim the inbox is clear.
    it('reports what is still in the inbox when the run skipped items', () => {
        expect(runSummaryNotice({ total: 3, skipped: 1 }, false)).toBe('Processed 2 of 3 — 1 still in the inbox.');
        expect(runSummaryNotice({ total: 2, skipped: 2 }, false)).toBe('Processed 0 of 2 — 2 still in the inbox.');
    });

    // The run returns to the inbox as it finishes, so a read-only warning raised by the last item
    // rides along rather than being replaced by the summary.
    it('carries the last item’s Gmail read-only warning along', () => {
        expect(runSummaryNotice({ total: 2, skipped: 0 }, true)).toBe(`Inbox clear! All 2 items processed. ${FROM_GMAIL_READONLY_MESSAGE}`);
    });
});
