/** `mergeServerOwnedRank`: a pulled (older) snapshot hands its `rank` to a newer local row that lacks one. */
import { describe, expect, it } from 'vitest';
import { mergeServerOwnedRank, RANK_CARRIED_FIELDS } from '../db/rankMerge';
import type { StoredItem } from '../types/MyDB';

const base: StoredItem = {
    _id: 'item-1',
    userId: 'user-1',
    status: 'nextAction',
    title: 'Call the plumber',
    createdTs: '2026-10-20T10:00:00.000Z',
    updatedTs: '2026-10-20T10:05:00.000Z',
};

const backfilled: StoredItem = { ...base, updatedTs: '2026-10-20T10:00:00.000Z', rank: 'a0V' };

describe('mergeServerOwnedRank', () => {
    it('adds the pulled rank to a newer local row without touching its own fields', () => {
        const local = { ...base, title: 'edited offline' };
        expect(mergeServerOwnedRank(local, backfilled)).toEqual({ ...local, rank: 'a0V' });
    });

    it.each(['inbox', 'calendar', 'waitingFor', 'somedayMaybe', 'done', 'trash'] as const)('merges into a %s row too (rank is universal)', (status) => {
        expect(mergeServerOwnedRank({ ...base, status }, backfilled)?.rank).toBe('a0V');
    });

    it('never overrides a local rank (the local row is newer — its own reorder wins)', () => {
        expect(mergeServerOwnedRank({ ...base, rank: 'Zz' }, backfilled)).toBeNull();
    });

    it('nothing to merge when the snapshot has no rank', () => {
        expect(mergeServerOwnedRank(base, { ...base, updatedTs: '2026-10-20T10:00:00.000Z' })).toBeNull();
    });

    it('same owner only — a cross-account replay must not hand a rank to a target-owned row', () => {
        expect(mergeServerOwnedRank({ ...base, userId: 'user-target' }, backfilled)).toBeNull();
    });

    it('parity pin — the SAME literals live in api-server/src/tests/rankCarryForward.test.ts; change both together', () => {
        expect(RANK_CARRIED_FIELDS).toEqual(['rank']);
    });
});
