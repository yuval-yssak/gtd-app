import type { IDBPDatabase } from 'idb';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { WindowVirtualizerHandle } from 'virtua';
import { reorderItem } from '../db/itemMutations';
import { grabPreviewOrder } from '../lib/dragReorder';
import { type FlatRow, flatIndexOfItem, flattenSections, type NextActionSection, type RankedRow } from '../lib/nextActionSections';
import { isFocusFree, rowElement } from '../lib/nextActionsRowDom';
import type { MyDB, StoredItem } from '../types/MyDB';
import { type ReorderCommit, useNextActionsDrag } from './useNextActionsDrag';
import { type RowCommand, useNextActionsRovingFocus } from './useNextActionsRovingFocus';

/**
 * A reorder for the list's own store to write: the section's LIVE rows as displayed, the moved row,
 * and the neighbours it lands between. A writer may plan against its own fuller group (routines:
 * the whole frequency group, search-hidden rows included) as long as it places the move between
 * these neighbours.
 */
export interface RankedRowReorder<T extends RankedRow> {
    sectionRows: T[];
    itemId: string;
    aboveId: string | undefined;
    belowId: string | undefined;
}

interface UseRankedRowsOptions<T extends RankedRow> {
    /** The list's sections in display order (one section for a flat list — the Inbox, Someday). */
    sections: ReadonlyArray<NextActionSection<T>>;
    isGhost: (row: T) => boolean;
    /** Writes the new order; resolves true when a row moved (false: a no-op, or the row/slot is gone). */
    reorder: (request: RankedRowReorder<T>) => Promise<boolean>;
    /** False for a flat list (one section, no header rows): the Inbox, Someday / Maybe. */
    hasHeaders?: boolean;
    /** The list's name as a keyboard region (F6 cycles to it by this name). */
    regionLabel: string;
}

interface UseRankedListOptions extends Omit<UseRankedRowsOptions<StoredItem>, 'reorder'> {
    db: IDBPDatabase<MyDB>;
    /** Every account of the merged list, visible rows or not: they share the keyspace, so a re-key must see them. */
    ownerIds: readonly string[];
    refreshItems: () => Promise<void>;
}

/**
 * Everything an ITEM list with a manual order needs, from the drag to the keyboard to "Move to…":
 * the Next Actions page, the Inbox, Someday / Maybe and Waiting For's "By date" view all run on it.
 * The order itself lives in `rank` (`db/itemMutations.reorderItem`). Other ranked rows (routines)
 * use `useRankedRows` with their own writer.
 */
export function useRankedList({ db, ownerIds, refreshItems, ...rows }: UseRankedListOptions) {
    const reorder = useCallback(
        async ({ sectionRows, itemId, aboveId, belowId }: RankedRowReorder<StoredItem>) => {
            const moved = await reorderItem(db, { sectionItems: sectionRows, itemId, aboveId, belowId, ownerIds });
            if (moved) {
                await refreshItems();
            }
            return moved !== null;
        },
        [db, refreshItems, ownerIds],
    );
    return useRankedRows({ ...rows, reorder });
}

/**
 * The manual-order machinery for any list of rows: drag, keyboard grab / nudge, roving focus and the
 * "Move to…" sheet. The page renders the rows (`flatRows`, headers included) with
 * `RankedRowHandle`, `rowProps` and `RankedListChrome`; `reorder` persists a move.
 */
export function useRankedRows<T extends RankedRow>({ sections, isGhost, reorder, hasHeaders = true, regionLabel }: UseRankedRowsOptions<T>) {
    const virtualizerRef = useRef<WindowVirtualizerHandle>(null);
    const dragHintId = useId();
    const rowHintId = useId();
    // Stored by id so the sheet always commits against the LIVE section (a pull can change it while the sheet is open).
    const [moveTarget, setMoveTarget] = useState<{ itemId: string; sectionKey: string } | null>(null);

    // The one commit every reorder gesture (drag, keyboard, Move to…) runs: the section's LIVE
    // rows (ghosts are fading leftovers — never a neighbour, never re-keyed) as displayed, plus the
    // neighbours by id; `reorderItem` reads the full section itself. Under filters or a search the
    // key is minted between the visible neighbours.
    const sectionsRef = useRef(sections);
    useLayoutEffect(() => {
        sectionsRef.current = sections;
    }, [sections]);
    const commitReorder = useCallback(
        async ({ sectionKey, itemId, aboveId, belowId }: ReorderCommit) => {
            const section = sectionsRef.current.find((candidate) => candidate.key === sectionKey);
            const live = section?.items.filter((row) => !isGhost(row)) ?? [];
            return reorder({ sectionRows: live, itemId, aboveId, belowId });
        },
        [isGhost, reorder],
    );

    // Reads the rendered rows through a ref: they are derived from the drag state this callback feeds.
    const flatRowsRef = useRef<FlatRow<T>[]>([]);
    const scrollRowIntoView = useCallback((itemId: string) => {
        const flatIndex = flatIndexOfItem(flatRowsRef.current, itemId);
        if (flatIndex >= 0) {
            virtualizerRef.current?.scrollToIndex(flatIndex, { align: 'nearest' });
        }
    }, []);
    const drag = useNextActionsDrag({ sections, isGhost, onCommit: commitReorder, scrollRowIntoView });

    // A keyboard grab renders its section in preview order — the grabbed row really moves to its
    // slot (so it stays mounted wherever the slot scrolls to); a pointer drag shifts rows with
    // transforms instead and renders the true order.
    const grabState = drag.previewGrab;
    const renderedSections = useMemo(
        () =>
            grabState
                ? sections.map((section) =>
                      section.key === grabState.sectionKey ? { ...section, items: grabPreviewOrder(section.items, grabState) } : section,
                  )
                : sections,
        [sections, grabState],
    );
    const flatRows = useMemo(() => flattenSections(renderedSections, hasHeaders), [renderedSections, hasHeaders]);
    useLayoutEffect(() => {
        flatRowsRef.current = flatRows;
    }, [flatRows]);

    const onRowCommand = useCallback(
        (command: RowCommand, item: T, section: NextActionSection<T>) => {
            if (command.type === 'grab') {
                drag.grab(item, section);
            } else if (command.type === 'commitNudge') {
                drag.commitStep(item, section, { delta: command.delta });
            } else if (command.type === 'commitJump') {
                drag.commitStep(item, section, { edge: command.edge });
            }
        },
        [drag.grab, drag.commitStep],
    );
    const roving = useNextActionsRovingFocus({ flatRows, isGhost, virtualizerRef, isReorderActive: drag.drag !== null, onRowCommand, regionLabel });

    const openMoveTo = useCallback((item: T, section: NextActionSection<T>) => setMoveTarget({ itemId: item._id, sectionKey: section.key }), []);
    const moveTargetSection = useMemo(() => sections.find((section) => section.key === moveTarget?.sectionKey), [sections, moveTarget]);
    const moveTargetItem = useMemo(() => moveTargetSection?.items.find((row) => row._id === moveTarget?.itemId) ?? null, [moveTargetSection, moveTarget]);
    const moveTargetLive = useMemo(() => moveTargetSection?.items.filter((row) => !isGhost(row)) ?? [], [moveTargetSection, isGhost]);
    // A target that vanished while the sheet was open (completed elsewhere, pulled away) closes the
    // sheet on its own; forget it too, or an undo bringing the row back would reopen the sheet.
    useEffect(() => {
        if (moveTarget && !moveTargetItem) {
            setMoveTarget(null);
        }
    }, [moveTarget, moveTargetItem]);
    const moveToSheet = {
        // Keyed by the target so a vanished row (the Drawer closes on its own) cannot leak its step/search into the next open.
        key: moveTarget?.itemId ?? 'closed',
        item: moveTargetItem,
        sectionItems: moveTargetLive,
        sectionLabel: moveTargetSection?.label ?? '',
        onClose: () => setMoveTarget(null),
        onMove: (neighbours: { aboveId: string | undefined; belowId: string | undefined }) => {
            if (moveTarget) {
                drag.commit({ sectionKey: moveTarget.sectionKey, itemId: moveTarget.itemId, ...neighbours });
            }
        },
    };

    /**
     * A keyboard user must not be left on a fading ghost row (Done, a status change): captured
     * BEFORE the row leaves, the hand-off moves focus to its neighbour afterwards — unless the
     * user has put focus somewhere else meanwhile (the search field), which is never stolen.
     */
    const focusHandOffFrom = useCallback(
        (itemId: string) => {
            const hadFocus = rowElement(itemId)?.contains(document.activeElement) === true;
            const next = roving.neighbourRowId(itemId);
            return () => {
                const current = rowElement(itemId);
                if (hadFocus && next !== undefined && (!current || isFocusFree(current))) {
                    roving.focusRow(next);
                }
            };
        },
        [roving.neighbourRowId, roving.focusRow],
    );

    return { virtualizerRef, drag, roving, flatRows, openMoveTo, moveToSheet, focusHandOffFrom, hintIds: { list: dragHintId, row: rowHintId } };
}

export type RankedListApi<T extends RankedRow = StoredItem> = ReturnType<typeof useRankedRows<T>>;
