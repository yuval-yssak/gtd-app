import type { StoredItem } from '../types/MyDB';
import { compareByRank, expectedDayKey } from './compareNextActions';
import { type NeighbourIds, nudgeNeighbours, type SectionEdge, sectionEdgeNeighbours } from './dragReorder';
import { sectionLabel } from './nextActionSections';
import { ownerIdsOfStatus, rankSectionKeyOf } from './rankSections';
import { isTicklerHidden } from './ticklerVisibility';

/** Pure logic behind the editor's "Position" row: the item's day section and the four moves it offers. */

/**
 * The rows the item shares its rank section with (itself included: a Next Actions or Waiting For
 * day, the Inbox, Someday / Maybe — `rankSectionKeyOf`), in list order, from the visible-accounts
 * list the editor's host already holds — the same section its page shows, so rows the tickler
 * hides (`ignoreBefore` in the future) are left out as the pages leave them out: "Up" must swap
 * with a row the user can see. The item is added when the list lacks it (its account is hidden),
 * so its position is always among real rows. Empty for a status with no manual order.
 */
export function daySectionOf(visibleItems: readonly StoredItem[], item: StoredItem, todayIso: string): StoredItem[] {
    const sectionKey = rankSectionKeyOf(item);
    if (sectionKey === null) {
        return [];
    }
    const rows = visibleItems.filter((row) => row._id !== item._id && rankSectionKeyOf(row) === sectionKey && !isTicklerHidden(row, todayIso));
    return [...rows, item].sort(compareByRank);
}

/** Every account the section's keyspace spans (see `ReorderRequest.ownerIds`): the visible owners of the item's status plus the item's. */
export function sectionOwnerIds(visibleItems: readonly StoredItem[], item: StoredItem): string[] {
    return [...new Set([...ownerIdsOfStatus(visibleItems, item.status), item.userId])];
}

const FLAT_SECTION_LABELS: Partial<Record<StoredItem['status'], string>> = { inbox: 'Inbox', somedayMaybe: 'Someday / Maybe' };

/** How the Position row names the item's section: its day ("Today", "Thu Oct 30") for the dated lists, the list's name otherwise. */
export function positionSectionLabel(item: StoredItem, todayIso: string): string {
    return FLAT_SECTION_LABELS[item.status] ?? sectionLabel(expectedDayKey(item), todayIso);
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

/** Which way a move took the item within its section — what a host walking the list needs to know. */
export type MoveDirection = 'up' | 'down';

/**
 * Where the drop lands relative to the item's current slot: below if the row it lands under
 * currently sits at or after the item (a "Move to…" pick is resolved the same way as Down/Bottom).
 */
export function moveDirectionOf(sectionIds: ReadonlyArray<string>, itemId: string, neighbours: NeighbourIds): MoveDirection {
    const aboveIndex = neighbours.aboveId === undefined ? -1 : sectionIds.indexOf(neighbours.aboveId);
    return aboveIndex >= sectionIds.indexOf(itemId) ? 'down' : 'up';
}
