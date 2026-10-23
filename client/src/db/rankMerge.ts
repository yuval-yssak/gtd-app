import type { StoredItem } from '../types/MyDB';

/**
 * The Next Actions priority key. Mirrors `RANK_CARRIED_FIELDS` in
 * `api-server/src/lib/rankCarryForward.ts` — pinned by the parity case in `tests/rankMerge.test.ts`;
 * change both together.
 */
export const RANK_CARRIED_FIELDS = ['rank'] as const;

/**
 * Field-level exception to whole-row last-write-wins for a pulled item snapshot that LOST to a
 * newer local row: a `rank` it carries and the local row lacks is merged in. "Absent" always means
 * "not minted / not pulled yet", never cleared (see `StoredItem.rank`), so this can never undo an
 * intentional clear. Same-owner only, like the calendar-link merge; status-independent, unlike it.
 * The server applies the same rule on push (`carryForwardRank`); this makes the rank available
 * locally right away so the row does not jump to the top of its section until the next echo.
 *
 * Returns the merged row, or null when there is nothing to merge. Pure; exported for unit tests.
 */
export function mergeServerOwnedRank(local: StoredItem, incoming: StoredItem): StoredItem | null {
    if (local.userId !== incoming.userId || local.rank !== undefined || incoming.rank === undefined) {
        return null;
    }
    return { ...local, rank: incoming.rank };
}
