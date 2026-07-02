import { describe, expect, it } from 'vitest';
import { missingClarifications } from '../lib/missingClarifications';
import type { StoredItem } from '../types/MyDB';

const item = (over: Partial<StoredItem>): StoredItem =>
    ({ _id: 'i1', userId: 'u', status: 'nextAction', title: 'T', createdTs: '', updatedTs: '', ...over }) as StoredItem;

describe('missingClarifications', () => {
    it('returns [] for a fully clarified item', () => {
        expect(missingClarifications(item({ energy: 'low', time: 5, workContextIds: ['c1'] }), true)).toEqual([]);
    });

    it('lists all three labels, in display order, when everything is missing and contexts exist', () => {
        expect(missingClarifications(item({}), true)).toEqual(['energy', 'time estimate', 'work context']);
    });

    it('lists only the actually-missing fields', () => {
        expect(missingClarifications(item({ time: 30, workContextIds: ['c1'] }), true)).toEqual(['energy']);
        expect(missingClarifications(item({ energy: 'high', workContextIds: ['c1'] }), true)).toEqual(['time estimate']);
    });

    it('treats an empty workContextIds array the same as undefined', () => {
        expect(missingClarifications(item({ energy: 'low', time: 5, workContextIds: [] }), true)).toEqual(['work context']);
    });

    it('skips the work-context criterion when the user has no work contexts defined', () => {
        expect(missingClarifications(item({ energy: 'low', time: 5 }), false)).toEqual([]);
    });

    it('still reports energy/time when the user has no work contexts', () => {
        expect(missingClarifications(item({}), false)).toEqual(['energy', 'time estimate']);
    });
});
