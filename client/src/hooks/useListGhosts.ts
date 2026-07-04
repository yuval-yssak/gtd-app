import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { consumeGhost, getGhostSnapshots, mergeGhostsIntoItems, pruneExpiredGhosts, subscribeToGhosts } from '../lib/listGhosts';
import type { StoredItem } from '../types/MyDB';

function ghostKeyOf(item: StoredItem): string {
    return `${item._id}:${item.status}`;
}

/**
 * Exposes "ghost" snapshots — items just removed from a list by a status change or
 * deletion — merged into the page's raw items so it can render them fading out in
 * their old position.
 *
 * Pages feed `itemsWithGhosts` through their normal status filter + sort: a ghost
 * carries its pre-mutation status, so it passes the filter of the list it just left
 * and sorts to where the live row used to be. `isGhost` matches on id AND status —
 * the live item (now on another list, e.g. Done) must keep rendering as a normal row.
 */
export function useListGhosts(liveItems: StoredItem[]) {
    useEffect(() => {
        pruneExpiredGhosts();
    }, []);
    const ghosts = useSyncExternalStore(subscribeToGhosts, getGhostSnapshots);
    // A ghost whose live item still holds the same status would collide with the real row post-filter — drop it.
    const ghostItems = useMemo(() => {
        const liveById = new Map(liveItems.map((item) => [item._id, item]));
        return ghosts.filter((ghost) => liveById.get(ghost._id)?.status !== ghost.status);
    }, [ghosts, liveItems]);
    const itemsWithGhosts = useMemo(() => mergeGhostsIntoItems(liveItems, ghostItems), [liveItems, ghostItems]);
    const ghostKeys = useMemo(() => new Set(ghostItems.map(ghostKeyOf)), [ghostItems]);
    return {
        itemsWithGhosts,
        isGhost: (item: StoredItem) => ghostKeys.has(ghostKeyOf(item)),
        onGhostExited: consumeGhost,
    };
}
