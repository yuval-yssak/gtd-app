import type { StoredItem } from '../types/MyDB';
import { compareNextActions, expectedDayKey } from './compareNextActions';
import { type NeighbourIds, nudgeNeighbours, type SectionEdge, sectionEdgeNeighbours } from './dragReorder';
import { isTicklerHidden } from './ticklerVisibility';

/** Pure logic behind the editor's "Position" row: the item's day section and the four moves it offers. */

/**
 * The next actions the item shares its day with (itself included), in list order, from the
 * visible-accounts list the editor's host already holds — the same section the Next Actions page
 * shows, so rows the tickler hides (`ignoreBefore` in the future) are left out as the page leaves
 * them out: "Up" must swap with a row the user can see. The item is added when the list lacks it
 * (its account is hidden), so its position is always among real rows.
 */
export function daySectionOf(visibleItems: readonly StoredItem[], item: StoredItem, todayIso: string): StoredItem[] {
    const dayKey = expectedDayKey(item);
    const rows = visibleItems.filter(
        (row) => row.status === 'nextAction' && row._id !== item._id && expectedDayKey(row) === dayKey && !isTicklerHidden(row, todayIso),
    );
    return [...rows, item].sort(compareNextActions);
}

/** Every account the section's keyspace spans (see `ReorderRequest.ownerIds`): the visible rows' owners plus the item's. */
export function sectionOwnerIds(visibleItems: readonly StoredItem[], item: StoredItem): string[] {
    return [...new Set([...visibleItems.filter((row) => row.status === 'nextAction').map((row) => row.userId), item.userId])];
}

export interface PositionMoves {
    /** 1-based position among the section's rows. */
    position: number;
    total: number;
    /** Each move's neighbours, or null when the move is not possible from here (already there, or alone). */
    top: NeighbourIds | null;
    up: NeighbourIds | null;
    down: NeighbourIds | null;
    bottom: NeighbourIds | null;
}

export function positionMoves(sectionItems: readonly StoredItem[], itemId: string): PositionMoves {
    const ids = sectionItems.map((row) => row._id);
    const edge = (which: SectionEdge) => sectionEdgeNeighbours(ids, itemId, which);
    return {
        position: ids.indexOf(itemId) + 1,
        total: ids.length,
        top: edge('top'),
        up: nudgeNeighbours(ids, itemId, -1),
        down: nudgeNeighbours(ids, itemId, 1),
        bottom: edge('bottom'),
    };
}
