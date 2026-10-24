import { describe, expect, it } from 'vitest';
import { inboxItemsInOrder } from '../lib/inboxOrder';
import type { StoredItem } from '../types/MyDB';

const BASE: StoredItem = {
    _id: 'item-A',
    userId: 'user-1',
    status: 'inbox',
    title: 'A',
    createdTs: '2026-01-01T00:00:00.000Z',
    updatedTs: '2026-01-01T00:00:00.000Z',
};

const inboxAt = (id: string, title: string, rank: string): StoredItem => ({ ...BASE, _id: id, title, rank });

// The inbox list and the Process Inbox run read the same order, so the run walks exactly what the
// inbox showed when "Process Inbox" was pressed — "process what I searched for".
describe('inboxItemsInOrder', () => {
    it('keeps only inbox items, in rank order', () => {
        const later = inboxAt('item-later', 'Later', 'b');
        const first = inboxAt('item-first', 'First', 'a');
        const nextAction: StoredItem = { ...inboxAt('item-na', 'Not inbox', '0'), status: 'nextAction' };
        expect(inboxItemsInOrder([later, nextAction, first], '').map((item) => item._id)).toEqual(['item-first', 'item-later']);
    });

    it('narrows to the items matching the inbox search', () => {
        const call = inboxAt('item-call', 'Call the bank', 'a');
        const email = inboxAt('item-email', 'Email Dana', 'b');
        expect(inboxItemsInOrder([call, email], 'bank').map((item) => item._id)).toEqual(['item-call']);
    });

    it('treats a blank search as no search', () => {
        const call = inboxAt('item-call', 'Call the bank', 'a');
        expect(inboxItemsInOrder([call], '   ')).toEqual([call]);
    });
});
