import type { SectionEdge } from './dragReorder';
import { type RowActionName, rowActionForKey } from './rowShortcuts';

/** The parts of a keyboard event the resolvers look at — a plain object so they are unit-testable in node. */
export interface KeyChord {
    key: string;
    altKey: boolean;
    shiftKey: boolean;
    metaKey: boolean;
    ctrlKey: boolean;
    repeat: boolean;
}

/** PageUp / PageDown move the grabbed row this many slots. */
export const PAGE_STEP = 5;

export type GrabKeyAction = { type: 'nudge'; delta: number } | { type: 'jump'; edge: SectionEdge } | { type: 'drop' } | { type: 'cancel' };

/** The row's own buttons, by the `data-row-action` each carries; a bare letter "clicks" one of them. */

export type RowKeyAction =
    | { type: 'focusStep'; delta: -1 | 1 }
    | { type: 'focusEdge'; edge: SectionEdge }
    | { type: 'enterActions' }
    | { type: 'grab' }
    | { type: 'commitNudge'; delta: -1 | 1 }
    | { type: 'commitJump'; edge: SectionEdge }
    | { type: 'rowAction'; action: RowActionName };

const ARROW_DELTA: Record<string, -1 | 1> = { ArrowUp: -1, ArrowDown: 1 };
const EDGE_KEYS: Record<string, SectionEdge> = { Home: 'top', End: 'bottom' };
const PAGE_KEYS: Record<string, number> = { PageUp: -PAGE_STEP, PageDown: PAGE_STEP };
/**
 * Every row action — the Next Actions list guards Done and has a Move to sheet (see `EVERY_ROW_ACTIONS`
 * for other lists). Bare letters only: ⌥+letter types an accented character on a Mac, so no letter
 * ever takes a modifier.
 */
export const NEXT_ACTIONS_ROW_ACTIONS: readonly RowActionName[] = ['edit', 'done', 'copyId', 'moveTo'];

function hasCommandModifier(chord: KeyChord): boolean {
    return chord.metaKey || chord.ctrlKey;
}

/**
 * Keys while a row is grabbed (window-level listener). Shift+arrow, Home and End jump to the
 * section's edges — the same chord on every platform, since a Mac keyboard has no Home/End.
 */
export function resolveGrabKey(chord: KeyChord): GrabKeyAction | null {
    if (hasCommandModifier(chord) || chord.altKey) {
        return null;
    }
    const arrow = ARROW_DELTA[chord.key];
    if (arrow !== undefined) {
        return chord.shiftKey ? { type: 'jump', edge: arrow < 0 ? 'top' : 'bottom' } : { type: 'nudge', delta: arrow };
    }
    const edge = EDGE_KEYS[chord.key];
    if (edge !== undefined) {
        return { type: 'jump', edge };
    }
    const page = PAGE_KEYS[chord.key];
    if (page !== undefined) {
        return { type: 'nudge', delta: page };
    }
    // A held Space must not alternate drop/grab on every repeat.
    if ((chord.key === ' ' || chord.key === 'Enter') && !chord.repeat) {
        return { type: 'drop' };
    }
    return chord.key === 'Escape' ? { type: 'cancel' } : null;
}

/**
 * Keys on a focused, un-grabbed row. Alt(⌥)+arrow commits one slot, Alt+Shift+arrow (and
 * Alt+Home/End) commit a jump to the section edge; key repeat is ignored for commits because a
 * held key would queue one write per repeat. Plain arrows walk the list; Space grabs the row
 * (Enter still opens it, as a button); bare letters act on the row.
 */
export function resolveRowKey(chord: KeyChord): RowKeyAction | null {
    if (hasCommandModifier(chord)) {
        return null;
    }
    return chord.altKey ? resolveAltRowKey(chord) : resolvePlainRowKey(chord);
}

function resolveAltRowKey(chord: KeyChord): RowKeyAction | null {
    if (chord.repeat) {
        return null;
    }
    const arrow = ARROW_DELTA[chord.key];
    if (arrow !== undefined) {
        return chord.shiftKey ? { type: 'commitJump', edge: arrow < 0 ? 'top' : 'bottom' } : { type: 'commitNudge', delta: arrow };
    }
    const edge = EDGE_KEYS[chord.key];
    return edge === undefined ? null : { type: 'commitJump', edge };
}

function resolvePlainRowKey(chord: KeyChord): RowKeyAction | null {
    if (chord.shiftKey) {
        return null;
    }
    const arrow = ARROW_DELTA[chord.key];
    if (arrow !== undefined) {
        return { type: 'focusStep', delta: arrow };
    }
    const edge = EDGE_KEYS[chord.key];
    if (edge !== undefined) {
        return { type: 'focusEdge', edge };
    }
    if (chord.key === 'ArrowRight') {
        return { type: 'enterActions' };
    }
    // Grabs and button presses are one-shot: a held key must not grab/drop or press Done repeatedly.
    if (chord.repeat) {
        return null;
    }
    if (chord.key === ' ') {
        return { type: 'grab' };
    }
    const action = rowActionForKey(chord.key, NEXT_ACTIONS_ROW_ACTIONS);
    return action === null ? null : { type: 'rowAction', action };
}
