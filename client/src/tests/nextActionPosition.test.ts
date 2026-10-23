import { describe, expect, it } from 'vitest';
import { daySectionOf, positionMoves, positionSectionLabel, sectionOwnerIds } from '../lib/nextActionPosition';
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

describe('daySectionOf / positionSectionLabel for the other ranked lists', () => {
    it('an inbox item is positioned among the inbox, a waiting item among its day; the calendar has no section', () => {
        const items = [
            row('i1', { status: 'inbox' }),
            row('i2', { status: 'inbox' }),
            row('w1', { status: 'waitingFor', expectedBy: '2026-11-01' }),
            row('w2', { status: 'waitingFor', expectedBy: '2026-11-02' }),
        ];
        expect(daySectionOf(items, row('i0', { status: 'inbox' }), TODAY).map((r) => r._id)).toEqual(['i0', 'i1', 'i2']);
        expect(daySectionOf(items, row('w0', { status: 'waitingFor', expectedBy: '2026-11-01' }), TODAY).map((r) => r._id)).toEqual(['w0', 'w1']);
        expect(daySectionOf(items, row('c', { status: 'calendar' }), TODAY)).toEqual([]);
    });

    it('labels the section by its list for the flat lists, by its day for the dated ones', () => {
        expect(positionSectionLabel(row('i', { status: 'inbox' }), TODAY)).toBe('Inbox');
        expect(positionSectionLabel(row('s', { status: 'somedayMaybe' }), TODAY)).toBe('Someday / Maybe');
        expect(positionSectionLabel(row('w', { status: 'waitingFor', expectedBy: TODAY }), TODAY)).toBe('Today');
        expect(positionSectionLabel(row('n'), TODAY)).toBe('No date');
    });

    it("owners span the item's status only", () => {
        const items = [row('a', { status: 'inbox', userId: 'u2' }), row('b', { userId: 'u3' })];
        expect(sectionOwnerIds(items, row('x', { status: 'inbox' }))).toEqual(['u2', 'u1']);
    });
});
