import { describe, expect, it } from 'vitest';
import { compareRank, isStrictlyIncreasing } from '../lib/itemRank';
import { planRoutineReorder } from '../lib/routineReorder';
import type { StoredRoutine } from '../types/MyDB';

function routine(_id: string, rank?: string): StoredRoutine {
    return {
        _id,
        userId: 'user-1',
        title: _id,
        routineType: 'nextAction',
        rrule: 'FREQ=DAILY',
        template: {},
        active: true,
        createdTs: '2026-01-01T00:00:00.000Z',
        updatedTs: '2026-01-01T00:00:00.000Z',
        ...(rank ? { rank } : {}),
    };
}

/** The group's order after applying the planned ranks (unplanned rows keep theirs). */
function orderAfter(group: StoredRoutine[], plan: ReturnType<typeof planRoutineReorder>) {
    const rankOf = new Map([...group.map((r): [string, string] => [r._id, r.rank ?? '']), ...plan.map((p): [string, string] => [p.routineId, p.rank])]);
    return [...group].sort((a, b) => compareRank(rankOf.get(a._id) ?? '', rankOf.get(b._id) ?? '')).map((r) => r._id);
}

describe('planRoutineReorder', () => {
    it('in a fully ranked group, re-keys only the moved routine between its new neighbours', () => {
        const group = [routine('a', 'a0'), routine('b', 'a1'), routine('c', 'a2')];

        const plan = planRoutineReorder(group, { routineId: 'c', aboveId: 'a', belowId: 'b' });

        expect(plan).toHaveLength(1);
        expect(orderAfter(group, plan)).toEqual(['a', 'c', 'b']);
    });

    it('moves to the top and to the bottom (one open end)', () => {
        const group = [routine('a', 'a0'), routine('b', 'a1'), routine('c', 'a2')];
        expect(orderAfter(group, planRoutineReorder(group, { routineId: 'c', aboveId: undefined, belowId: 'a' }))).toEqual(['c', 'a', 'b']);
        expect(orderAfter(group, planRoutineReorder(group, { routineId: 'a', aboveId: 'c', belowId: undefined }))).toEqual(['b', 'c', 'a']);
    });

    // A group never reordered has no ranks: the first move keys the whole group in its displayed
    // order with the moved routine at its new slot, so nothing else jumps.
    it('keys a never-ranked group in display order on the first move', () => {
        const group = [routine('a'), routine('b'), routine('c')];

        const plan = planRoutineReorder(group, { routineId: 'a', aboveId: 'b', belowId: 'c' });

        expect(plan.map((p) => p.routineId).sort()).toEqual(['a', 'b', 'c']);
        expect(isStrictlyIncreasing(['b', 'a', 'c'].map((id) => plan.find((p) => p.routineId === id)?.rank ?? ''))).toBe(true);
    });

    it('keys a partly ranked group (a new routine arrived unranked) in display order', () => {
        const group = [routine('a', 'a0'), routine('b', 'a1'), routine('new')];

        const plan = planRoutineReorder(group, { routineId: 'new', aboveId: undefined, belowId: 'a' });

        expect(orderAfter(group, plan)).toEqual(['new', 'a', 'b']);
    });

    // Under a title search only some of the group is visible: the move lands relative to the
    // visible neighbours, and hidden routines keep their place in the group.
    it('places the move between the given neighbours even when others sit between them in the full group', () => {
        const group = [routine('a', 'a0'), routine('hidden', 'a1'), routine('b', 'a2'), routine('c', 'a3')];

        const plan = planRoutineReorder(group, { routineId: 'c', aboveId: 'a', belowId: 'hidden' });

        expect(orderAfter(group, plan)).toEqual(['a', 'c', 'hidden', 'b']);
    });

    it("keys the whole group when the neighbours' keys are out of order (a tie after a resume)", () => {
        const group = [routine('a', 'a1'), routine('b', 'a1'), routine('c', 'a2')];

        const plan = planRoutineReorder(group, { routineId: 'c', aboveId: undefined, belowId: 'a' });

        expect(plan.length).toBeGreaterThan(1);
        expect(orderAfter(group, plan)).toEqual(['c', 'a', 'b']);
    });

    it('keys the whole group when the key between the neighbours would grow too long', () => {
        const longAbove = `a0${'z'.repeat(40)}`;
        const group = [routine('a', longAbove), routine('b', `${longAbove}V`), routine('c', 'b0')];

        const plan = planRoutineReorder(group, { routineId: 'c', aboveId: 'a', belowId: 'b' });

        expect(plan.length).toBeGreaterThan(1);
        expect(orderAfter(group, plan)).toEqual(['a', 'c', 'b']);
    });

    it('lands at the bottom when neither neighbour is in the group any more', () => {
        const group = [routine('a', 'a0'), routine('b', 'a1'), routine('c', 'a2')];

        const plan = planRoutineReorder(group, { routineId: 'a', aboveId: 'gone', belowId: 'also-gone' });

        expect(orderAfter(group, plan)).toEqual(['b', 'c', 'a']);
    });

    it('is empty for a move onto its own slot or an unknown routine', () => {
        const group = [routine('a', 'a0'), routine('b', 'a1')];
        expect(planRoutineReorder(group, { routineId: 'b', aboveId: 'a', belowId: undefined })).toEqual([]);
        expect(planRoutineReorder(group, { routineId: 'gone', aboveId: 'a', belowId: undefined })).toEqual([]);
    });
});
