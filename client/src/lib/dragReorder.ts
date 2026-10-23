/**
 * Pure core of the Next Actions drag and drop (vertical, one day section at a time, one item).
 * The DOM glue lives in `hooks/useNextActionsDrag.ts`; everything that can be reasoned about
 * without a browser — where the pointer drops, how displaced rows shift, which neighbours a
 * commit lands between — is a reducer here so it is unit-tested in node (no jsdom in this repo).
 *
 * Indexing: `itemIds` is the WHOLE section in display order (the dragged item included);
 * `toIndex` is the slot among the OTHER items (0 … others.length), i.e. the dragged item's final
 * position in the section. Rects cover only the MOUNTED rows — virtua unmounts rows outside the
 * viewport — so the drop slot is resolved from mounted rows and mapped back onto the full list.
 */

import { hasAtLeastOne } from './typeUtils';

export type SectionEdge = 'top' | 'bottom';

/** One committed keyboard step on an un-grabbed row: Alt+arrow (one slot) or Alt+Shift+arrow / Alt+Home/End (a section edge). */
export type RowStep = { delta: -1 | 1 } | { edge: SectionEdge };

export interface RowRect {
    id: string;
    top: number;
    height: number;
}

export interface DragState {
    itemId: string;
    sectionKey: string;
    /** Section rows in display order, the dragged item included. */
    itemIds: string[];
    /** Mounted section rows' viewport geometry at the last `lift`/`rectsChanged`. */
    rects: RowRect[];
    fromIndex: number;
    toIndex: number;
    draggedHeight: number;
    startY: number;
    pointerY: number;
    /** True while the pointer has left the section's bounds — a release here snaps back. */
    isOutside: boolean;
    /** Keyboard grab mode: nudges move the slot, there is no pointer. */
    isKeyboard: boolean;
    /** True once the slot has differed from the origin at any point during the drag. */
    hadMoved: boolean;
}

export type DragEvent =
    | { type: 'lift'; itemId: string; sectionKey: string; itemIds: string[]; rects: RowRect[]; pointerY: number; isKeyboard?: boolean }
    | { type: 'move'; pointerY: number }
    | { type: 'rectsChanged'; rects: RowRect[] }
    /** One animation frame of a pointer drag: fresh mounted rects + the latest pointer, re-targeted once. */
    | { type: 'frame'; rects: RowRect[]; pointerY: number }
    /** Grab mode: move the slot by `delta` rows (clamped to the section); PageUp/Down pass several. */
    | { type: 'nudge'; delta: number }
    /** Grab mode: Shift+arrow / Home / End — straight to the first or last slot. */
    | { type: 'jump'; edge: SectionEdge }
    | { type: 'drop' }
    | { type: 'cancel' };

/** The rows a commit lands between, by id — resolved against the LIVE rows at commit time, so a
 *  section that gained or lost a row mid-drag cannot land the item one slot off. */
export interface NeighbourIds {
    aboveId: string | undefined;
    belowId: string | undefined;
}

export type DragEffect =
    /** `isKeyboard`: a grab-mode drop — the hook gives focus back to the row once the move has rendered. */
    | ({ type: 'commit'; itemId: string; sectionKey: string; fromIndex: number; toIndex: number; isKeyboard: boolean } & NeighbourIds)
    /** `hadMoved`: the slot left its origin at some point (a bare press-and-release has not). */
    | { type: 'snapBack'; hadMoved: boolean }
    | { type: 'slotChanged'; toIndex: number };

export interface DragStep {
    state: DragState | null;
    effects: DragEffect[];
}

/** How far past the section's first/last row the pointer may stray before a release snaps back. */
export const SECTION_WALL_SLACK_PX = 24;

const NO_EFFECTS: DragEffect[] = [];

export function dragReducer(state: DragState | null, event: DragEvent): DragStep {
    if (event.type === 'lift') {
        // A handle that is not among the section's live rows (a ghost's handle reached by keyboard) cannot start a drag.
        return { state: event.itemIds.includes(event.itemId) ? liftState(event) : null, effects: NO_EFFECTS };
    }
    if (!state) {
        return { state: null, effects: NO_EFFECTS };
    }
    switch (event.type) {
        case 'move':
            return retarget({ ...state, pointerY: event.pointerY });
        case 'rectsChanged':
            return retarget({ ...state, rects: event.rects });
        case 'frame':
            return retarget({ ...state, rects: event.rects, pointerY: event.pointerY });
        case 'nudge':
            return moveSlot(state, state.toIndex + event.delta);
        case 'jump':
            return moveSlot(state, event.edge === 'top' ? 0 : state.itemIds.length - 1);
        case 'drop':
            return { state: null, effects: [dropEffect(state)] };
        case 'cancel':
            return { state: null, effects: [{ type: 'snapBack', hadMoved: state.hadMoved }] };
    }
}

function liftState(event: Extract<DragEvent, { type: 'lift' }>): DragState {
    const fromIndex = event.itemIds.indexOf(event.itemId);
    const draggedHeight = event.rects.find((rect) => rect.id === event.itemId)?.height ?? 0;
    return {
        itemId: event.itemId,
        sectionKey: event.sectionKey,
        itemIds: event.itemIds,
        rects: event.rects,
        fromIndex,
        toIndex: fromIndex,
        draggedHeight,
        startY: event.pointerY,
        pointerY: event.pointerY,
        isOutside: false,
        isKeyboard: event.isKeyboard === true,
        hadMoved: false,
    };
}

/** Re-resolves the drop slot and the section wall after a pointer move or a rect refresh. */
function retarget(state: DragState): DragStep {
    if (state.isKeyboard) {
        return { state, effects: NO_EFFECTS };
    }
    const toIndex = computeDropIndex(state.pointerY, state.rects, state.itemId, state.itemIds);
    const isOutside = isOutsideSection(state.pointerY, state.rects, state.itemIds);
    const next = { ...state, toIndex, isOutside, hadMoved: state.hadMoved || toIndex !== state.fromIndex };
    return { state: next, effects: toIndex === state.toIndex ? NO_EFFECTS : [{ type: 'slotChanged', toIndex }] };
}

/** True when a step changed something a render depends on (slot, wall, mode) — geometry alone does not. */
export function needsRender(previous: DragState | null, next: DragState | null): boolean {
    if (previous === null || next === null) {
        return previous !== next;
    }
    return previous.toIndex !== next.toIndex || previous.isOutside !== next.isOutside || previous.itemId !== next.itemId;
}

/** Grab mode: the slot moves to `requested`, clamped to the section; landing where it already is changes nothing. */
function moveSlot(state: DragState, requested: number): DragStep {
    const toIndex = Math.min(Math.max(requested, 0), state.itemIds.length - 1);
    if (toIndex === state.toIndex) {
        return { state, effects: NO_EFFECTS };
    }
    return { state: { ...state, toIndex, hadMoved: true }, effects: [{ type: 'slotChanged', toIndex }] };
}

function dropEffect(state: DragState): DragEffect {
    if (state.isOutside || state.toIndex === state.fromIndex) {
        return { type: 'snapBack', hadMoved: state.hadMoved };
    }
    const others = othersOf(state.itemIds, state.itemId);
    return {
        type: 'commit',
        itemId: state.itemId,
        sectionKey: state.sectionKey,
        fromIndex: state.fromIndex,
        toIndex: state.toIndex,
        isKeyboard: state.isKeyboard,
        aboveId: others[state.toIndex - 1],
        belowId: others[state.toIndex],
    };
}

/**
 * The `translateY` (px) a computed `transform` currently applies, or 0. Rows carry their drag
 * displacement as a transform on the very element whose rect is measured, so the hook subtracts
 * this to recover the untransformed geometry the reducer reasons about (otherwise a row shifted
 * by a whole row height would move the section wall and the drop midpoints with it).
 */
export function translateYOf(transform: string): number {
    const match = /^matrix\((?:[^,]+,){5}\s*([-\d.e]+)\)$/.exec(transform.trim());
    return match ? Number(match[1]) || 0 : 0;
}

/** The section's rows other than the dragged one, in display order. */
export function othersOf(itemIds: readonly string[], draggedId: string): string[] {
    return itemIds.filter((id) => id !== draggedId);
}

/**
 * The slot (among the other rows) the pointer is over: the number of mounted other rows whose
 * vertical midpoint is above the pointer, mapped onto the full section. A pointer below every
 * mounted other row lands right after the last mounted one — rows further down are unmounted only
 * because they are off-screen, and the pointer is never off-screen.
 */
export function computeDropIndex(pointerY: number, rects: readonly RowRect[], draggedId: string, itemIds: readonly string[]): number {
    const others = othersOf(itemIds, draggedId);
    const mountedOthers = rects.filter((rect) => rect.id !== draggedId && others.includes(rect.id));
    if (mountedOthers.length === 0) {
        return 0;
    }
    const firstBelow = mountedOthers.find((rect) => pointerY < rect.top + rect.height / 2);
    if (firstBelow) {
        return others.indexOf(firstBelow.id);
    }
    const last = mountedOthers[mountedOthers.length - 1];
    return last ? others.indexOf(last.id) + 1 : 0;
}

/**
 * True when the pointer is past the section's first row's top or last row's bottom (plus slack)
 * — only judged against an edge row that is actually mounted; an unmounted edge means the section
 * continues beyond the viewport, so the pointer cannot be outside it on that side.
 */
export function isOutsideSection(pointerY: number, rects: readonly RowRect[], itemIds: readonly string[]): boolean {
    const first = rects.find((rect) => rect.id === itemIds[0]);
    const last = rects.find((rect) => rect.id === itemIds[itemIds.length - 1]);
    const aboveTop = first !== undefined && pointerY < first.top - SECTION_WALL_SLACK_PX;
    const belowBottom = last !== undefined && pointerY > last.top + last.height + SECTION_WALL_SLACK_PX;
    return aboveTop || belowBottom;
}

/**
 * The vertical shift (px) a NON-dragged row at `otherIndex` (its index among the other rows)
 * takes while the dragged row is headed for `toIndex`: rows between the origin and the target make
 * room by the dragged row's OWN height (rows are variable height — a tag row, an expanded editor).
 */
export function shiftFor(fromIndex: number, toIndex: number, draggedHeight: number): (otherIndex: number) => number {
    return (otherIndex) => {
        if (otherIndex >= toIndex && otherIndex < fromIndex) {
            return draggedHeight;
        }
        if (otherIndex >= fromIndex && otherIndex < toIndex) {
            return -draggedHeight;
        }
        return 0;
    };
}

/**
 * The displacement of the row with `id` (dragged rows follow the pointer and are not shifted here).
 * A keyboard grab shifts nothing: the page renders the section in `grabPreviewOrder` instead, so
 * the grabbed row really sits at its slot (virtua keeps it mounted wherever the slot scrolls to).
 */
export function shiftForRow(state: DragState, id: string): number {
    if (state.isKeyboard) {
        return 0;
    }
    const others = othersOf(state.itemIds, state.itemId);
    const otherIndex = others.indexOf(id);
    return otherIndex < 0 ? 0 : shiftFor(state.fromIndex, state.toIndex, state.draggedHeight)(otherIndex);
}

export interface Neighbours<T> {
    above: T | undefined;
    below: T | undefined;
}

/**
 * The rows a commit lands between: the other rows at `toIndex - 1` and `toIndex`. Callers pass
 * the section's LIVE rows (ghosts excluded — a fading row that already left the list is not a
 * valid neighbour, and must never be re-keyed).
 */
export function neighboursAt<T extends { _id: string }>(sectionItems: readonly T[], draggedId: string, toIndex: number): Neighbours<T> {
    const others = sectionItems.filter((item) => item._id !== draggedId);
    return { above: others[toIndex - 1], below: others[toIndex] };
}

/**
 * Keyboard grab: the section's rows (ghosts included) with the grabbed row moved to its slot —
 * right before the live row at `toIndex` among the others, or last. The pointer path shifts rows
 * with transforms instead; see `shiftForRow`.
 */
export function grabPreviewOrder<T extends { _id: string }>(sectionItems: readonly T[], state: DragState): T[] {
    const dragged = sectionItems.find((row) => row._id === state.itemId);
    if (!dragged) {
        return [...sectionItems];
    }
    const rest = sectionItems.filter((row) => row._id !== state.itemId);
    const belowId = othersOf(state.itemIds, state.itemId)[state.toIndex];
    const insertAt = belowId === undefined ? rest.length : rest.findIndex((row) => row._id === belowId);
    return insertAt < 0 ? [...rest, dragged] : [...rest.slice(0, insertAt), dragged, ...rest.slice(insertAt)];
}

/** Alt+Shift+arrow / Home / End: the neighbours at the section's first or last slot, or null when the row is already there. */
export function sectionEdgeNeighbours(itemIds: readonly string[], draggedId: string, edge: SectionEdge): NeighbourIds | null {
    const others = othersOf(itemIds, draggedId);
    const fromIndex = itemIds.indexOf(draggedId);
    if (fromIndex < 0 || !hasAtLeastOne(others) || fromIndex === (edge === 'top' ? 0 : others.length)) {
        return null;
    }
    return edge === 'top' ? { aboveId: undefined, belowId: others[0] } : { aboveId: others[others.length - 1], belowId: undefined };
}

/** The slot a "Move to…" request lands in among the OTHER rows: right before `belowId`, or last; a vanished `belowId` reads as the top (the commit itself then refuses). */
export function slotOfNeighbours(itemIds: readonly string[], itemId: string, belowId: string | undefined): number {
    const others = othersOf(itemIds, itemId);
    return belowId === undefined ? others.length : Math.max(others.indexOf(belowId), 0);
}

/**
 * True once a committed move shows in the rendered section: the row sits at the slot it was
 * planned for, or it left the section altogether (completed elsewhere meanwhile). The render
 * barrier the commit queue waits on — `refreshItems()` resolves when the refresh STARTS (a
 * transition), not when the new list is on screen.
 */
export function hasMoveRendered(liveIds: readonly string[], itemId: string, toIndex: number): boolean {
    const index = liveIds.indexOf(itemId);
    return index < 0 || index === toIndex;
}

/** A committed keyboard step resolved against the section's live rows: the neighbours to land between and the final slot, or null when it goes nowhere. */
export function planStep(itemIds: readonly string[], draggedId: string, step: RowStep): { neighbours: NeighbourIds; toIndex: number } | null {
    if ('delta' in step) {
        const neighbours = nudgeNeighbours(itemIds, draggedId, step.delta);
        return neighbours && { neighbours, toIndex: itemIds.indexOf(draggedId) + step.delta };
    }
    const neighbours = sectionEdgeNeighbours(itemIds, draggedId, step.edge);
    return neighbours && { neighbours, toIndex: step.edge === 'top' ? 0 : itemIds.length - 1 };
}

/** Grab mode / Alt+arrow: the slot one step up or down from the item's current position, or null at the edge. */
export function nudgedSlot(itemIds: readonly string[], draggedId: string, delta: -1 | 1): number | null {
    const fromIndex = itemIds.indexOf(draggedId);
    const toIndex = fromIndex + delta;
    return toIndex < 0 || toIndex > itemIds.length - 1 ? null : toIndex;
}

/** Alt+arrow: the neighbours one slot up or down from the item's current position, or null at the edge. */
export function nudgeNeighbours(itemIds: readonly string[], draggedId: string, delta: -1 | 1): NeighbourIds | null {
    const toIndex = nudgedSlot(itemIds, draggedId, delta);
    if (toIndex === null) {
        return null;
    }
    const others = othersOf(itemIds, draggedId);
    return { aboveId: others[toIndex - 1], belowId: others[toIndex] };
}
