import { type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject, useCallback, useLayoutEffect, useRef } from 'react';
import type { WindowVirtualizerHandle } from 'virtua';
import type { SectionEdge } from '../lib/dragReorder';
import { type FlatRow, flatIndexOfItem, type NextActionSection } from '../lib/nextActionSections';
import { type RowActionName, type RowKeyAction, resolveRowKey } from '../lib/nextActionsKeys';
import { ROW_ACTION_ATTR, ROW_ITEM_ATTR, rowActionButtonsOf, rowButtonOf, rowElement, rowOfTarget, whenRowMounted } from '../lib/nextActionsRowDom';
import type { StoredItem } from '../types/MyDB';

/** A row key the page acts on (the hook keeps the focus-only keys to itself). */
export type RowCommand = Exclude<RowKeyAction, { type: 'focusStep' } | { type: 'focusEdge' } | { type: 'enterActions' } | { type: 'rowAction' }>;

interface UseNextActionsRovingFocusOptions {
    /** The rows as rendered (preview order during a keyboard grab), headers included. */
    flatRows: readonly FlatRow<StoredItem>[];
    isGhost: (item: StoredItem) => boolean;
    virtualizerRef: RefObject<WindowVirtualizerHandle | null>;
    /** True while a drag or keyboard grab is live — the grab's window listener owns the keys then. */
    isReorderActive: boolean;
    onRowCommand: (command: RowCommand, item: StoredItem, section: NextActionSection<StoredItem>) => void;
}

export interface NextActionsRovingFocusApi {
    /** Spread on the list container: the ONE tab stop, forwarding focus to the remembered row. */
    listProps: {
        tabIndex: 0;
        onFocus: (e: ReactFocusEvent<HTMLElement>) => void;
        onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
    };
    /** Spread on each row button: out of the tab order, and Space must not "click" it (Space grabs). */
    rowButtonProps: { tabIndex: -1; onKeyUp: (e: ReactKeyboardEvent<HTMLElement>) => void };
    /** Spread on each of the row's action buttons (`action` names it for the letter shortcuts). */
    actionButtonProps: (action: RowActionName) => { tabIndex: -1; [ROW_ACTION_ATTR]: RowActionName };
    /** Focus a row by id (scrolling it into virtua's range first when needed). */
    focusRow: (itemId: string) => void;
    /** The live row after `itemId` in list order (or before it, at the end) — where focus goes once a row leaves the list. */
    neighbourRowId: (itemId: string) => string | undefined;
}

const isElement = (target: EventTarget | null): target is HTMLElement => target instanceof HTMLElement;

/** Keys on one of the row's action buttons: ←/→ walk the buttons, ← past the first or Esc returns to the row. True when handled. */
function walkActionButtons(key: string, row: HTMLElement, button: HTMLElement): boolean {
    const buttons = rowActionButtonsOf(row);
    const idx = buttons.indexOf(button);
    if (key === 'ArrowRight') {
        buttons[idx + 1]?.focus();
    } else if (key === 'ArrowLeft') {
        (buttons[idx - 1] ?? rowButtonOf(row))?.focus();
    } else if (key === 'Escape') {
        rowButtonOf(row)?.focus();
    } else {
        return false;
    }
    return true;
}

/**
 * One tab stop for the whole Next Actions list (the WAI-ARIA listbox pattern): Tab lands on the
 * list, which hands focus to the last-focused row; ↑/↓ walk the rows, Home/End jump to the ends,
 * → steps into the row's buttons (←/Esc back), bare letters press them, Space grabs the row for
 * reordering. The rows and their buttons are tabIndex -1, so Tab leaves the list in one press.
 * Rows are virtualized: a row that is not mounted is scrolled into range before it is focused.
 */
export function useNextActionsRovingFocus({
    flatRows,
    isGhost,
    virtualizerRef,
    isReorderActive,
    onRowCommand,
}: UseNextActionsRovingFocusOptions): NextActionsRovingFocusApi {
    const activeRowId = useRef<string | null>(null);
    // Read by event handlers, which outlive a render.
    const rowsRef = useRef(flatRows);
    const reorderActiveRef = useRef(isReorderActive);
    useLayoutEffect(() => {
        rowsRef.current = flatRows;
        reorderActiveRef.current = isReorderActive;
    }, [flatRows, isReorderActive]);

    const liveRowIds = useCallback(() => rowsRef.current.flatMap((row) => (row.kind === 'item' && !isGhost(row.item) ? [row.item._id] : [])), [isGhost]);

    const focusRow = useCallback(
        (itemId: string) => {
            activeRowId.current = itemId;
            if (!rowElement(itemId)) {
                const flatIndex = flatIndexOfItem(rowsRef.current, itemId);
                if (flatIndex < 0) {
                    return;
                }
                virtualizerRef.current?.scrollToIndex(flatIndex, { align: 'nearest' });
            }
            // Only the LAST requested row may take focus: two quick key presses start two waits, and
            // the earlier one (its row still mounting) must not win after the later one focused.
            whenRowMounted(itemId, (row) => {
                if (activeRowId.current === itemId) {
                    rowButtonOf(row)?.focus();
                }
            });
        },
        [virtualizerRef],
    );

    const focusStep = useCallback(
        (fromId: string | null, delta: -1 | 1) => {
            const ids = liveRowIds();
            const next = fromId === null ? ids[0] : ids[ids.indexOf(fromId) + delta];
            if (next !== undefined) {
                focusRow(next);
            }
        },
        [liveRowIds, focusRow],
    );

    const focusEdge = useCallback(
        (edge: SectionEdge) => {
            const ids = liveRowIds();
            const target = edge === 'top' ? ids[0] : ids.at(-1);
            if (target !== undefined) {
                focusRow(target);
            }
        },
        [liveRowIds, focusRow],
    );

    const neighbourRowId = useCallback(
        (itemId: string) => {
            const ids = liveRowIds();
            const idx = ids.indexOf(itemId);
            return ids[idx + 1] ?? ids[idx - 1];
        },
        [liveRowIds],
    );

    /** The remembered row when it is still in the list, else the first live row. */
    const rememberedRowId = useCallback(() => {
        const ids = liveRowIds();
        const remembered = activeRowId.current;
        return remembered !== null && ids.includes(remembered) ? remembered : ids[0];
    }, [liveRowIds]);

    // Keyboard focus onto the container (Tab from outside it) → the remembered row. Focus arriving
    // from inside the list (Shift+Tab out of a row) stays on the container, so the next Shift+Tab
    // leaves — forwarding it back would trap the user. A mouse click on a header or divider also
    // focuses the container, and must not scroll the page to a far-away remembered row.
    const onListFocus = useCallback(
        (e: ReactFocusEvent<HTMLElement>) => {
            const row = rowOfTarget(e.target);
            if (row) {
                activeRowId.current = row.getAttribute(ROW_ITEM_ATTR);
                return;
            }
            const fromInside = isElement(e.relatedTarget) && e.currentTarget.contains(e.relatedTarget);
            if (e.target !== e.currentTarget || fromInside || !e.currentTarget.matches(':focus-visible')) {
                return;
            }
            const target = rememberedRowId();
            if (target !== undefined) {
                focusRow(target);
            }
        },
        [rememberedRowId, focusRow],
    );

    /** Arrow keys while focus sits on the container itself (the Shift+Tab stop): step into the rows. */
    const onContainerKey = useCallback(
        (key: string) => {
            if (key === 'ArrowDown' || key === 'Home') {
                focusEdge('top');
            } else if (key === 'ArrowUp' || key === 'End') {
                focusEdge('bottom');
            } else {
                return false;
            }
            return true;
        },
        [focusEdge],
    );

    const runRowKey = useCallback(
        (action: RowKeyAction, row: HTMLElement, flat: Extract<FlatRow<StoredItem>, { kind: 'item' }>) => {
            const itemId = flat.item._id;
            if (action.type === 'focusStep') {
                focusStep(itemId, action.delta);
            } else if (action.type === 'focusEdge') {
                focusEdge(action.edge);
            } else if (action.type === 'enterActions') {
                rowActionButtonsOf(row)[0]?.focus();
            } else if (action.type === 'rowAction') {
                row.querySelector<HTMLElement>(`[${ROW_ACTION_ATTR}="${action.action}"]`)?.click();
            } else {
                onRowCommand(action, flat.item, flat.section);
            }
        },
        [focusStep, focusEdge, onRowCommand],
    );

    const onListKeyDown = useCallback(
        (e: ReactKeyboardEvent<HTMLElement>) => {
            if (reorderActiveRef.current || !isElement(e.target)) {
                return;
            }
            const row = rowOfTarget(e.target);
            if (!row) {
                if (e.target === e.currentTarget && onContainerKey(e.key)) {
                    e.preventDefault();
                }
                return;
            }
            const actionButton = e.target.closest(`[${ROW_ACTION_ATTR}]`);
            if (actionButton instanceof HTMLElement) {
                // Space/Enter/letters on a button press the button itself — only the walking keys are ours.
                if (walkActionButtons(e.key, row, actionButton)) {
                    e.preventDefault();
                }
                return;
            }
            const action = resolveRowKey(e);
            const flat = rowsRef.current.find((candidate) => candidate.kind === 'item' && candidate.item._id === row.getAttribute(ROW_ITEM_ATTR));
            // A ghost (a row fading out after Done) can only be walked away from: pressing its buttons
            // would act on a stale snapshot (Done twice re-runs the routine follow-up).
            const isWalk = action?.type === 'focusStep' || action?.type === 'focusEdge';
            if (!action || !flat || flat.kind !== 'item' || (isGhost(flat.item) && !isWalk)) {
                return;
            }
            e.preventDefault();
            runRowKey(action, row, flat);
        },
        [onContainerKey, runRowKey, isGhost],
    );

    // MUI synthesises a click from Space on keyUP of a non-native button — Space is the grab/drop key here.
    const onRowButtonKeyUp = useCallback((e: ReactKeyboardEvent<HTMLElement>) => {
        if (e.key === ' ') {
            e.preventDefault();
        }
    }, []);

    const actionButtonProps = useCallback((action: RowActionName) => ({ tabIndex: -1 as const, [ROW_ACTION_ATTR]: action }), []);

    return {
        listProps: { tabIndex: 0, onFocus: onListFocus, onKeyDown: onListKeyDown },
        rowButtonProps: { tabIndex: -1, onKeyUp: onRowButtonKeyUp },
        actionButtonProps,
        focusRow,
        neighbourRowId,
    };
}
