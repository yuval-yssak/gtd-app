import { describe, expect, it } from 'vitest';
import { compareByRank, type MoveTarget, parseMoveBody, planItemMove, type RankedRow, rankSectionKeyOf, rowMissingFromSection } from '../lib/itemMove.js';
import { compareRank, isRankTooLong, RANK_TOO_LONG_THRESHOLD } from '../lib/itemRank.js';

function row(id: string, rank?: string, createdTs = '2026-01-01T00:00:00.000Z'): RankedRow {
    return { _id: id, createdTs, ...(rank !== undefined ? { rank } : {}) };
}

/** The section's display order after the plan's writes are applied — what the user would see. */
function orderAfter(section: readonly RankedRow[], movedId: string, target: MoveTarget): string[] {
    const plan = planItemMove(section, movedId, target);
    const written = new Map(plan.writes.map((write) => [write.id, write.rank]));
    return section
        .map((r) => {
            const rank = written.get(r._id) ?? r.rank;
            return { ...r, ...(rank !== undefined ? { rank } : {}) };
        })
        .sort(compareByRank)
        .map((r) => r._id);
}

const RANKED = [row('a', 'a0'), row('b', 'a1'), row('c', 'a2'), row('d', 'a3')];

describe('planItemMove — a well-ranked section', () => {
    it.each<[MoveTarget, string[]]>([
        [{ position: 'top' }, ['c', 'a', 'b', 'd']],
        [{ position: 'bottom' }, ['a', 'b', 'd', 'c']],
        [{ before: 'b' }, ['a', 'c', 'b', 'd']],
        [{ after: 'd' }, ['a', 'b', 'd', 'c']],
        [{ after: 'a' }, ['a', 'c', 'b', 'd']],
        [{ before: 'a' }, ['c', 'a', 'b', 'd']],
    ])('moves c to %j', (target, expected) => {
        expect(orderAfter(RANKED, 'c', target)).toEqual(expected);
    });

    it('writes exactly one key (on the moved row) when its new neighbours are strictly ordered', () => {
        const plan = planItemMove(RANKED, 'c', { position: 'top' });
        expect(plan.writes.map((write) => write.id)).toEqual(['c']);
    });

    it.each<MoveTarget>([{ before: 'd' }, { after: 'b' }])('is a no-op when the item already sits at %j', (target) => {
        expect(planItemMove(RANKED, 'c', target)).toEqual({ writes: [], position: 3, total: 4 });
    });

    it('is a no-op for top when already first and for bottom when already last', () => {
        expect(planItemMove(RANKED, 'a', { position: 'top' }).writes).toEqual([]);
        expect(planItemMove(RANKED, 'd', { position: 'bottom' }).writes).toEqual([]);
    });

    it('reports the 1-based position and section size after the move', () => {
        expect(planItemMove(RANKED, 'a', { position: 'bottom' })).toMatchObject({ position: 4, total: 4 });
        expect(planItemMove(RANKED, 'd', { before: 'b' })).toMatchObject({ position: 2, total: 4 });
    });

    it('accepts the section in any order (it sorts by the display comparator itself)', () => {
        const shuffled = [RANKED[2], RANKED[0], RANKED[3], RANKED[1]].filter((r) => r !== undefined);
        expect(orderAfter(shuffled, 'a', { after: 'c' })).toEqual(['b', 'c', 'a', 'd']);
    });

    it('is a no-op for a section holding only the item', () => {
        expect(planItemMove([row('solo', 'a0')], 'solo', { position: 'bottom' })).toEqual({ writes: [], position: 1, total: 1 });
    });
});

describe('planItemMove — sections that need re-keying', () => {
    it('ranks the unranked rows sitting above the target slot so the move can land between them', () => {
        // Unranked rows sort first (newest createdTs first): u2, u1, then a, b.
        const section = [row('u1', undefined, '2026-01-01T00:00:00.000Z'), row('u2', undefined, '2026-01-02T00:00:00.000Z'), row('a', 'a0'), row('b', 'a1')];
        expect(orderAfter(section, 'b', { after: 'u2' })).toEqual(['u2', 'b', 'u1', 'a']);
        expect(orderAfter(section, 'b', { position: 'top' })).toEqual(['b', 'u2', 'u1', 'a']);
    });

    it('moves an unranked row to the bottom with one write', () => {
        const section = [row('u', undefined), row('a', 'a0'), row('b', 'a1')];
        const plan = planItemMove(section, 'u', { position: 'bottom' });
        expect(plan.writes.map((write) => write.id)).toEqual(['u']);
        expect(orderAfter(section, 'u', { position: 'bottom' })).toEqual(['a', 'b', 'u']);
    });

    it('splits equal keys (concurrent mints) so the item lands between them', () => {
        const section = [row('a', 'a0'), row('b', 'a0'), row('c', 'a1')];
        expect(orderAfter(section, 'c', { after: 'a' })).toEqual(['a', 'c', 'b']);
    });

    it('always leaves the whole section strictly increasing in display order', () => {
        const section = [row('u', undefined), row('a', 'a0'), row('b', 'a0'), row('c', 'a0'), row('d', 'a2')];
        const plan = planItemMove(section, 'd', { before: 'b' });
        const written = new Map(plan.writes.map((write) => [write.id, write.rank]));
        const ranks = orderAfter(section, 'd', { before: 'b' }).map((id) => written.get(id) ?? section.find((r) => r._id === id)?.rank);
        expect(ranks.every((rank) => rank !== undefined)).toBe(true);
        const keys = ranks.filter((rank): rank is string => rank !== undefined);
        expect(keys.slice(1).every((key, idx) => compareRank(keys[idx] ?? '', key) < 0)).toBe(true);
    });

    it('re-keys the whole section from the origin when the minted key would grow too long', () => {
        // A valid key just above `a0` whose midpoint with `a0` exceeds the length threshold.
        const tight = `a0${'0'.repeat(RANK_TOO_LONG_THRESHOLD)}1`;
        const section = [row('a', 'a0'), row('b', tight), row('c', 'a1')];
        const plan = planItemMove(section, 'c', { after: 'a' });
        expect(plan.writes.map((write) => write.id)).toEqual(['a', 'c', 'b']);
        expect(plan.writes.every((write) => !isRankTooLong(write.rank))).toBe(true);
        expect(orderAfter(section, 'c', { after: 'a' })).toEqual(['a', 'c', 'b']);
    });

    it('throws when the anchor is not in the section (the caller validates first)', () => {
        expect(() => planItemMove(RANKED, 'c', { before: 'missing' })).toThrow();
    });
});

describe('rankSectionKeyOf', () => {
    it('keys nextAction and waitingFor by expected day, undated separately', () => {
        expect(rankSectionKeyOf({ status: 'nextAction', expectedBy: '2026-11-03' }, 'UTC')).toBe('nextAction:2026-11-03');
        expect(rankSectionKeyOf({ status: 'waitingFor' }, 'UTC')).toBe('waitingFor:undated');
    });

    it("collapses a datetime expectedBy to the user's local day", () => {
        // 02:00Z on the 3rd is still the 2nd in New York.
        expect(rankSectionKeyOf({ status: 'nextAction', expectedBy: '2026-11-03T02:00:00.000Z' }, 'America/New_York')).toBe('nextAction:2026-11-02');
        expect(rankSectionKeyOf({ status: 'nextAction', expectedBy: '2026-11-03T02:00:00.000Z' }, 'UTC')).toBe('nextAction:2026-11-03');
    });

    it('reads a datetime without an offset as wall time in the user zone, as the app reads it on the device', () => {
        // 23:30 floating on the 2nd is the 2nd in Tokyo — never converted from the server's UTC to the 3rd.
        expect(rankSectionKeyOf({ status: 'nextAction', expectedBy: '2026-11-02T23:30:00' }, 'Asia/Tokyo')).toBe('nextAction:2026-11-02');
        expect(rankSectionKeyOf({ status: 'nextAction', expectedBy: '2026-11-05T02:00:00' }, 'America/New_York')).toBe('nextAction:2026-11-05');
    });

    it('converts a datetime with an explicit offset into the user zone', () => {
        expect(rankSectionKeyOf({ status: 'nextAction', expectedBy: '2026-11-03T01:00:00+09:00' }, 'UTC')).toBe('nextAction:2026-11-02');
    });

    it('keeps a date-only expectedBy as-is in any zone', () => {
        expect(rankSectionKeyOf({ status: 'nextAction', expectedBy: '2026-11-03' }, 'Pacific/Kiritimati')).toBe('nextAction:2026-11-03');
    });

    it('treats inbox and somedayMaybe as one flat section each, ignoring expectedBy', () => {
        expect(rankSectionKeyOf({ status: 'inbox' }, 'UTC')).toBe('inbox');
        expect(rankSectionKeyOf({ status: 'somedayMaybe', expectedBy: '2026-11-03' }, 'UTC')).toBe('somedayMaybe');
    });

    it.each(['calendar', 'done', 'trash'] as const)('has no manual order for %s', (status) => {
        expect(rankSectionKeyOf({ status }, 'UTC')).toBeNull();
    });
});

describe('rowMissingFromSection', () => {
    it('is null while the item and its anchor are both in the section', () => {
        expect(rowMissingFromSection(RANKED, 'c', { before: 'a' })).toBeNull();
        expect(rowMissingFromSection(RANKED, 'c', { position: 'top' })).toBeNull();
    });

    it('names the item when it left the section', () => {
        expect(rowMissingFromSection(RANKED, 'gone', { position: 'top' })).toBe('item');
    });

    it('names the anchor when it left the section', () => {
        expect(rowMissingFromSection(RANKED, 'c', { after: 'gone' })).toBe('anchor');
    });
});

describe('compareByRank', () => {
    it('puts unranked rows first (newest first), then rank by code unit, then _id', () => {
        const rows = [
            row('z', 'a0'),
            row('B', 'B0'),
            row('old', undefined, '2026-01-01T00:00:00.000Z'),
            row('new', undefined, '2026-02-01T00:00:00.000Z'),
            row('y', 'a0'),
        ];
        // Code-unit order puts 'B0' before 'a0' (uppercase sorts before lowercase).
        expect([...rows].sort(compareByRank).map((r) => r._id)).toEqual(['new', 'old', 'B', 'y', 'z']);
    });
});

describe('parseMoveBody', () => {
    it.each<[unknown, MoveTarget]>([
        [{ position: 'top' }, { position: 'top' }],
        [{ position: 'bottom' }, { position: 'bottom' }],
        [{ before: 'x' }, { before: 'x' }],
        [{ after: 'x' }, { after: 'x' }],
    ])('accepts %j', (raw, expected) => {
        expect(parseMoveBody(raw)).toEqual({ ok: true, value: expected });
    });

    it.each<unknown>([
        null,
        [],
        {},
        { position: 'middle' },
        { before: '' },
        { after: '   ' },
        { before: 7 },
        { position: 'top', before: 'x' },
        { before: 'x', after: 'y' },
        { position: 'top', extra: 1 },
    ])('rejects %j', (raw) => {
        expect(parseMoveBody(raw)).toMatchObject({ ok: false });
    });
});
