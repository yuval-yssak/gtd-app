import { afterEach, describe, expect, it } from 'vitest';
import {
    consumeGhost,
    GHOST_TTL_MS,
    getGhostSnapshots,
    mergeGhostsIntoItems,
    pruneExpiredGhosts,
    recordGhostSnapshot,
    resetGhostStore,
    subscribeToGhosts,
} from '../lib/listGhosts';
import type { StoredItem } from '../types/MyDB';

function buildItem(id: string, status: StoredItem['status'] = 'nextAction'): StoredItem {
    return { _id: id, userId: 'u1', status, title: `Item ${id}`, createdTs: '2026-07-04T10:00:00.000Z', updatedTs: '2026-07-04T10:00:00.000Z' };
}

afterEach(() => {
    resetGhostStore();
});

describe('ghost store', () => {
    it('exposes a recorded snapshot with its pre-mutation status', () => {
        recordGhostSnapshot(buildItem('a', 'nextAction'), 1_000);
        const [ghost] = getGhostSnapshots();
        if (!ghost) throw new Error('expected one ghost');
        expect(ghost._id).toBe('a');
        expect(ghost.status).toBe('nextAction');
    });

    it('re-recording the same item replaces its entry instead of duplicating it', () => {
        recordGhostSnapshot(buildItem('a', 'nextAction'), 1_000);
        recordGhostSnapshot(buildItem('a', 'waitingFor'), 2_000);
        expect(getGhostSnapshots()).toHaveLength(1);
        expect(getGhostSnapshots()[0]?.status).toBe('waitingFor');
    });

    it('consumeGhost removes the entry and notifies subscribers', () => {
        let notifications = 0;
        const unsubscribe = subscribeToGhosts(() => {
            notifications += 1;
        });
        recordGhostSnapshot(buildItem('a'), 1_000);
        consumeGhost('a');
        expect(getGhostSnapshots()).toHaveLength(0);
        expect(notifications).toBe(2);
        unsubscribe();
    });

    it('consuming an unknown id does not notify', () => {
        let notifications = 0;
        const unsubscribe = subscribeToGhosts(() => {
            notifications += 1;
        });
        consumeGhost('missing');
        expect(notifications).toBe(0);
        unsubscribe();
    });

    it('prunes entries older than the TTL, keeping fresh ones', () => {
        recordGhostSnapshot(buildItem('old'), 1_000);
        recordGhostSnapshot(buildItem('fresh'), 1_000 + GHOST_TTL_MS);
        pruneExpiredGhosts(1_001 + GHOST_TTL_MS);
        const snapshots = getGhostSnapshots();
        expect(snapshots).toHaveLength(1);
        expect(snapshots[0]?._id).toBe('fresh');
    });

    it('recording also prunes expired entries', () => {
        recordGhostSnapshot(buildItem('old'), 1_000);
        recordGhostSnapshot(buildItem('new'), 2_000 + GHOST_TTL_MS);
        expect(getGhostSnapshots().map((g) => g._id)).toEqual(['new']);
    });

    it('keeps the snapshot referentially stable between mutations', () => {
        recordGhostSnapshot(buildItem('a'), 1_000);
        expect(getGhostSnapshots()).toBe(getGhostSnapshots());
    });
});

describe('mergeGhostsIntoItems', () => {
    it('returns the live array untouched when there are no ghosts', () => {
        const liveItems = [buildItem('a'), buildItem('b')];
        expect(mergeGhostsIntoItems(liveItems, [])).toBe(liveItems);
    });

    it('inserts a ghost right after its live counterpart so stable sorts keep its old position', () => {
        const liveItems = [buildItem('a'), buildItem('b', 'done'), buildItem('c')];
        const ghostOfB = buildItem('b', 'nextAction');
        const merged = mergeGhostsIntoItems(liveItems, [ghostOfB]);
        expect(merged.map((item) => `${item._id}:${item.status}`)).toEqual(['a:nextAction', 'b:done', 'b:nextAction', 'c:nextAction']);
    });

    it('appends ghosts of hard-deleted items (no live counterpart) at the end', () => {
        const liveItems = [buildItem('a')];
        const ghostOfDeleted = buildItem('gone', 'trash');
        const merged = mergeGhostsIntoItems(liveItems, [ghostOfDeleted]);
        expect(merged.map((item) => item._id)).toEqual(['a', 'gone']);
    });

    it('two ghosts sharing an id dedupe to the last one (defensive — the store keys by id)', () => {
        const liveItems = [buildItem('a', 'done')];
        const merged = mergeGhostsIntoItems(liveItems, [buildItem('a', 'nextAction'), buildItem('a', 'waitingFor')]);
        expect(merged.map((item) => `${item._id}:${item.status}`)).toEqual(['a:done', 'a:waitingFor']);
    });
});
