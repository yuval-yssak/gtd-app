import { describe, expect, it } from 'vitest';
import {
    computeDropIndex,
    type DragState,
    dragReducer,
    isOutsideSection,
    needsRender,
    neighboursAt,
    nudgedSlot,
    nudgeNeighbours,
    type RowRect,
    SECTION_WALL_SLACK_PX,
    shiftFor,
    shiftForRow,
    translateYOf,
} from '../lib/dragReorder';

/** Four 50 px rows stacked from y=100: a 100–150, b 150–200, c 200–250, d 250–300. */
const ids = ['a', 'b', 'c', 'd'];
const rects: RowRect[] = ids.map((id, idx) => ({ id, top: 100 + idx * 50, height: 50 }));

function lift(itemId: string, pointerY: number, overrides: Partial<Parameters<typeof dragReducer>[1] & { type: 'lift' }> = {}) {
    return dragReducer(null, { type: 'lift', itemId, sectionKey: 'no-date', itemIds: ids, rects, pointerY, ...overrides });
}

function stateOf(step: ReturnType<typeof dragReducer>): DragState {
    if (!step.state) {
        throw new Error('expected an active drag');
    }
    return step.state;
}

describe('computeDropIndex', () => {
    it('is the number of other rows whose midpoint is above the pointer', () => {
        // Dragging c (200–250). Others: a(mid 125), b(mid 175), d(mid 275).
        expect(computeDropIndex(110, rects, 'c', ids)).toBe(0);
        expect(computeDropIndex(130, rects, 'c', ids)).toBe(1);
        expect(computeDropIndex(180, rects, 'c', ids)).toBe(2);
        expect(computeDropIndex(280, rects, 'c', ids)).toBe(3);
    });

    it('maps a drop among MOUNTED rows back onto the full section when rows above are unmounted', () => {
        // Only c and d are mounted (a, b scrolled out above). Pointer between c and d → slot after c.
        const mounted = rects.filter((rect) => rect.id === 'c' || rect.id === 'd');
        expect(computeDropIndex(240, mounted, 'd', ids)).toBe(3);
        // Pointer above c's midpoint while dragging d → slot before c = index 2 among others [a, b, c].
        expect(computeDropIndex(210, mounted, 'd', ids)).toBe(2);
    });

    it('a pointer below every mounted other row lands right after the last mounted one', () => {
        const mounted = rects.filter((rect) => rect.id === 'a' || rect.id === 'b');
        expect(computeDropIndex(400, mounted, 'a', ids)).toBe(1);
    });

    it('a single-row section always drops at slot 0', () => {
        const [first] = rects;
        if (!first) throw new Error('expected a rect');
        expect(computeDropIndex(999, [first], 'a', ['a'])).toBe(0);
    });
});

describe('isOutsideSection', () => {
    it('is outside only past the mounted first/last row plus slack', () => {
        expect(isOutsideSection(100 - SECTION_WALL_SLACK_PX - 1, rects, ids)).toBe(true);
        expect(isOutsideSection(100 - SECTION_WALL_SLACK_PX + 1, rects, ids)).toBe(false);
        expect(isOutsideSection(300 + SECTION_WALL_SLACK_PX + 1, rects, ids)).toBe(true);
        expect(isOutsideSection(200, rects, ids)).toBe(false);
    });

    it('an unmounted edge row means the section continues off-screen — never outside on that side', () => {
        const withoutFirst = rects.filter((rect) => rect.id !== 'a');
        expect(isOutsideSection(0, withoutFirst, ids)).toBe(false);
        const withoutLast = rects.filter((rect) => rect.id !== 'd');
        expect(isOutsideSection(9999, withoutLast, ids)).toBe(false);
    });
});

describe('shiftFor', () => {
    it('rows between origin and target shift by the dragged height, in the opposite direction', () => {
        // Dragging from 0 towards slot 2: others at 0 and 1 move up.
        const down = shiftFor(0, 2, 50);
        expect([0, 1, 2].map(down)).toEqual([-50, -50, 0]);
        // Dragging from 3 towards slot 1: others at 1 and 2 move down.
        const up = shiftFor(3, 1, 70);
        expect([0, 1, 2].map(up)).toEqual([0, 70, 70]);
    });

    it('no shift when the slot equals the origin', () => {
        expect([0, 1, 2].map(shiftFor(1, 1, 50))).toEqual([0, 0, 0]);
    });
});

describe('dragReducer', () => {
    it('lift captures the origin slot and the dragged row height', () => {
        const state = stateOf(lift('b', 175));
        expect(state).toMatchObject({ fromIndex: 1, toIndex: 1, draggedHeight: 50, startY: 175, pointerY: 175, isOutside: false });
    });

    it('moving past a midpoint changes the slot once and shifts the displaced row', () => {
        const lifted = lift('a', 125);
        const moved = dragReducer(lifted.state, { type: 'move', pointerY: 180 });
        expect(moved.effects).toEqual([{ type: 'slotChanged', toIndex: 1 }]);
        const state = stateOf(moved);
        expect(shiftForRow(state, 'b')).toBe(-50);
        expect(shiftForRow(state, 'c')).toBe(0);
        const same = dragReducer(state, { type: 'move', pointerY: 185 });
        expect(same.effects).toEqual([]);
    });

    it('drop commits with the final slot AND the neighbour ids, and ends the drag', () => {
        const moved = dragReducer(lift('d', 275).state, { type: 'move', pointerY: 160 });
        const dropped = dragReducer(moved.state, { type: 'drop' });
        expect(dropped.state).toBeNull();
        expect(dropped.effects).toEqual([{ type: 'commit', itemId: 'd', sectionKey: 'no-date', fromIndex: 3, toIndex: 1, aboveId: 'a', belowId: 'b' }]);
        // Section edges have an open neighbour.
        const toTop = dragReducer(lift('d', 275).state, { type: 'move', pointerY: 110 });
        expect(dragReducer(toTop.state, { type: 'drop' }).effects).toEqual([
            { type: 'commit', itemId: 'd', sectionKey: 'no-date', fromIndex: 3, toIndex: 0, aboveId: undefined, belowId: 'a' },
        ]);
    });

    it('a frame event re-reads rects and the pointer in one step', () => {
        const lifted = lift('a', 125, { rects: rects.slice(0, 2) });
        const framed = dragReducer(lifted.state, { type: 'frame', rects, pointerY: 280 });
        expect(framed.effects).toEqual([{ type: 'slotChanged', toIndex: 3 }]);
        expect(stateOf(framed).rects).toHaveLength(4);
    });

    it('a lift for a handle that is not among the live rows (a ghost reached by keyboard) starts nothing', () => {
        expect(dragReducer(null, { type: 'lift', itemId: 'ghost', sectionKey: 's', itemIds: ids, rects, pointerY: 0 })).toEqual({ state: null, effects: [] });
    });

    it('needsRender is true only when the slot, the wall or the drag itself changed', () => {
        const a = stateOf(lift('a', 125));
        expect(needsRender(null, a)).toBe(true);
        expect(needsRender(a, null)).toBe(true);
        expect(needsRender(a, { ...a, pointerY: 130, rects: [] })).toBe(false);
        expect(needsRender(a, { ...a, toIndex: 2 })).toBe(true);
        expect(needsRender(a, { ...a, isOutside: true })).toBe(true);
    });

    it('drop without a slot change snaps back (no write)', () => {
        const dropped = dragReducer(lift('b', 175).state, { type: 'drop' });
        expect(dropped.effects).toEqual([{ type: 'snapBack', hadMoved: false }]);
    });

    it('cancel snaps back from any slot', () => {
        const moved = dragReducer(lift('a', 125).state, { type: 'move', pointerY: 290 });
        expect(stateOf(moved).toIndex).toBe(3);
        expect(dragReducer(moved.state, { type: 'cancel' })).toEqual({ state: null, effects: [{ type: 'snapBack', hadMoved: true }] });
    });

    it('a release outside the section snaps back even after the slot changed; the slot stays clamped to the section', () => {
        const moved = dragReducer(lift('a', 125).state, { type: 'move', pointerY: 400 });
        const state = stateOf(moved);
        expect(state.toIndex).toBe(3);
        expect(state.isOutside).toBe(true);
        expect(dragReducer(state, { type: 'drop' }).effects).toEqual([{ type: 'snapBack', hadMoved: true }]);
        // Coming back inside clears the flag.
        const back = stateOf(dragReducer(state, { type: 'move', pointerY: 290 }));
        expect(back.isOutside).toBe(false);
    });

    it('rects changing mid-drag (virtua mounted a new range) re-resolves the slot from the new geometry', () => {
        const lifted = lift('a', 125, { rects: rects.slice(0, 2) });
        const moved = dragReducer(lifted.state, { type: 'move', pointerY: 280 });
        // Only a and b were mounted: past b → slot 1.
        expect(stateOf(moved).toIndex).toBe(1);
        const refreshed = dragReducer(moved.state, { type: 'rectsChanged', rects });
        expect(refreshed.effects).toEqual([{ type: 'slotChanged', toIndex: 3 }]);
    });

    it("variable row heights: the drop midpoint uses each row's own height and displaced rows shift by the dragged row's height", () => {
        const tall: RowRect[] = [
            { id: 'a', top: 0, height: 40 },
            { id: 'b', top: 40, height: 200 },
            { id: 'c', top: 240, height: 40 },
        ];
        const lifted = dragReducer(null, { type: 'lift', itemId: 'c', sectionKey: 's', itemIds: ['a', 'b', 'c'], rects: tall, pointerY: 260 });
        // b's midpoint is 140: a pointer at 150 is still below it → slot 2 (unchanged); at 130 → slot 1.
        expect(stateOf(dragReducer(lifted.state, { type: 'move', pointerY: 150 })).toIndex).toBe(2);
        const above = stateOf(dragReducer(lifted.state, { type: 'move', pointerY: 130 }));
        expect(above.toIndex).toBe(1);
        expect(shiftForRow(above, 'b')).toBe(40);
        expect(shiftForRow(above, 'a')).toBe(0);
    });

    it('keyboard grab: nudges move the slot and clamp at the section edges; pointer moves are ignored', () => {
        const lifted = lift('b', 0, { rects: [], isKeyboard: true });
        const up = dragReducer(lifted.state, { type: 'nudge', delta: -1 });
        expect(up.effects).toEqual([{ type: 'slotChanged', toIndex: 0 }]);
        const clamped = dragReducer(up.state, { type: 'nudge', delta: -1 });
        expect(clamped.effects).toEqual([]);
        expect(stateOf(clamped).toIndex).toBe(0);
        const ignored = dragReducer(clamped.state, { type: 'move', pointerY: 999 });
        expect(stateOf(ignored).toIndex).toBe(0);
        const down = dragReducer(ignored.state, { type: 'nudge', delta: 1 });
        const further = dragReducer(down.state, { type: 'nudge', delta: 1 });
        const atEnd = dragReducer(further.state, { type: 'nudge', delta: 1 });
        expect(stateOf(atEnd).toIndex).toBe(3);
        expect(dragReducer(atEnd.state, { type: 'nudge', delta: 1 }).effects).toEqual([]);
        expect(dragReducer(atEnd.state, { type: 'drop' }).effects).toEqual([
            { type: 'commit', itemId: 'b', sectionKey: 'no-date', fromIndex: 1, toIndex: 3, aboveId: 'd', belowId: undefined },
        ]);
    });

    it('events without an active drag are ignored', () => {
        expect(dragReducer(null, { type: 'move', pointerY: 1 })).toEqual({ state: null, effects: [] });
        expect(dragReducer(null, { type: 'drop' })).toEqual({ state: null, effects: [] });
    });
});

describe('neighboursAt', () => {
    const items = ids.map((_id) => ({ _id }));

    it('returns the other rows around the slot, skipping the dragged item', () => {
        expect(neighboursAt(items, 'c', 1)).toEqual({ above: { _id: 'a' }, below: { _id: 'b' } });
        expect(neighboursAt(items, 'c', 0)).toEqual({ above: undefined, below: { _id: 'a' } });
        expect(neighboursAt(items, 'c', 3)).toEqual({ above: { _id: 'd' }, below: undefined });
    });

    it('ghost rows are excluded by the caller — a pre-filtered list never offers them', () => {
        const live = items.filter((item) => item._id !== 'b');
        expect(neighboursAt(live, 'c', 1)).toEqual({ above: { _id: 'a' }, below: { _id: 'd' } });
    });
});

describe('nudgedSlot / nudgeNeighbours', () => {
    it('one slot up or down, null at the edges', () => {
        expect(nudgedSlot(ids, 'b', -1)).toBe(0);
        expect(nudgedSlot(ids, 'b', 1)).toBe(2);
        expect(nudgedSlot(ids, 'a', -1)).toBeNull();
        expect(nudgedSlot(ids, 'd', 1)).toBeNull();
    });

    it('resolves the neighbours one slot up or down, open at the section edges', () => {
        expect(nudgeNeighbours(ids, 'b', -1)).toEqual({ aboveId: undefined, belowId: 'a' });
        expect(nudgeNeighbours(ids, 'b', 1)).toEqual({ aboveId: 'c', belowId: 'd' });
        expect(nudgeNeighbours(ids, 'c', 1)).toEqual({ aboveId: 'd', belowId: undefined });
        expect(nudgeNeighbours(ids, 'a', -1)).toBeNull();
    });
});

describe('translateYOf', () => {
    it('reads the Y translation out of a computed matrix() and treats everything else as 0', () => {
        expect(translateYOf('matrix(1, 0, 0, 1, 0, 52)')).toBe(52);
        expect(translateYOf('matrix(1, 0, 0, 1, 0, -17.5)')).toBe(-17.5);
        expect(translateYOf('none')).toBe(0);
        expect(translateYOf('')).toBe(0);
    });
});
