import { describe, expect, it } from 'vitest';
import { daySectionOf, positionMoves, sectionOwnerIds } from '../lib/nextActionPosition';
import type { StoredItem } from '../types/MyDB';

const row = (id: string, overrides: Partial<StoredItem> = {}): StoredItem => ({
    _id: id,
    userId: 'u1',
    status: 'nextAction',
    title: id,
    createdTs: '2026-01-01T00:00:00.000Z',
    updatedTs: '2026-01-01T00:00:00.000Z',
    rank: id,
    ...overrides,
});

const TODAY = '2026-10-23';

describe('daySectionOf', () => {
    it('keeps the next actions sharing the item’s day, in list order, the item included', () => {
        const items = [row('b'), row('c', { expectedBy: '2026-10-30' }), row('a'), row('x', { status: 'inbox' })];
        expect(daySectionOf(items, row('a'), TODAY).map((r) => r._id)).toEqual(['a', 'b']);
        expect(daySectionOf(items, row('c', { expectedBy: '2026-10-30' }), TODAY).map((r) => r._id)).toEqual(['c']);
    });

    it('adds the item itself when the visible list lacks it (its account is hidden)', () => {
        const items = [row('b')];
        expect(daySectionOf(items, row('a', { userId: 'u2' }), TODAY).map((r) => r._id)).toEqual(['a', 'b']);
    });

    it('leaves out rows the tickler hides from the page, so "Up" never swaps with an invisible row', () => {
        const items = [row('a'), row('b', { ignoreBefore: '2026-11-01' }), row('c')];
        expect(daySectionOf(items, row('c'), TODAY).map((r) => r._id)).toEqual(['a', 'c']);
        // The item itself is kept even while snoozed (the editor can open it from the tickler page).
        expect(daySectionOf(items, row('b', { ignoreBefore: '2026-11-01' }), TODAY).map((r) => r._id)).toEqual(['a', 'b', 'c']);
    });
});

describe('sectionOwnerIds', () => {
    it('spans every visible next-action owner plus the item’s own account, once each', () => {
        const items = [row('b'), row('c', { userId: 'u2' }), row('d', { userId: 'u2', status: 'done' })];
        expect(sectionOwnerIds(items, row('a', { userId: 'u3' }))).toEqual(['u1', 'u2', 'u3']);
    });
});

describe('positionMoves', () => {
    const section = [row('a'), row('b'), row('c')];

    it('offers all four moves from the middle', () => {
        expect(positionMoves(section, 'b')).toEqual({
            position: 2,
            total: 3,
            top: { aboveId: undefined, belowId: 'a' },
            up: { aboveId: undefined, belowId: 'a' },
            down: { aboveId: 'c', belowId: undefined },
            bottom: { aboveId: 'c', belowId: undefined },
        });
    });

    it('disables the moves that would land where the row already is', () => {
        const atTop = positionMoves(section, 'a');
        expect([atTop.top, atTop.up]).toEqual([null, null]);
        expect(atTop.down).toEqual({ aboveId: 'b', belowId: 'c' });
        expect(atTop.bottom).toEqual({ aboveId: 'c', belowId: undefined });
        const alone = positionMoves([row('a')], 'a');
        expect(alone).toEqual({ position: 1, total: 1, top: null, up: null, down: null, bottom: null });
    });
});
