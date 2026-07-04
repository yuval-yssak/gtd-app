import dayjs from 'dayjs';
import type { StoredItem } from '../types/MyDB';

/**
 * Ghosts are meant to be seen once, right after the removal — an old ghost
 * resurfacing minutes later would read as the item coming back, so entries
 * expire quickly even if never displayed.
 *
 * Known edge (accepted): entries are not scoped by account, so switching accounts
 * within the TTL can briefly surface a ghost from the previous account's list. The
 * short TTL plus consume-on-display keeps the window negligible.
 */
export const GHOST_TTL_MS = 60 * 1000;

interface GhostEntry {
    item: StoredItem;
    recordedAtMs: number;
}

// Module-level store (not React state) so the db mutation layer can record
// ghosts without a React dependency; pages subscribe via useSyncExternalStore.
const ghostsByItemId = new Map<string, GhostEntry>();
const listeners = new Set<() => void>();
// useSyncExternalStore requires a referentially stable snapshot between notifications.
let ghostSnapshotCache: StoredItem[] = [];

function notifyGhostListeners(): void {
    ghostSnapshotCache = [...ghostsByItemId.values()].map((entry) => entry.item);
    for (const listener of listeners) {
        listener();
    }
}

/**
 * Records the pre-mutation snapshot of an item that just left a list (status
 * change or deletion), so the list it disappeared from can briefly render a
 * fading "ghost" of it in its old position.
 */
export function recordGhostSnapshot(item: StoredItem, nowMs = dayjs().valueOf()): void {
    pruneExpiredGhosts(nowMs);
    ghostsByItemId.set(item._id, { item, recordedAtMs: nowMs });
    notifyGhostListeners();
}

/** Removes a ghost once its collapse animation finished (or it was otherwise handled). */
export function consumeGhost(itemId: string): void {
    if (ghostsByItemId.delete(itemId)) {
        notifyGhostListeners();
    }
}

/** Drops entries older than GHOST_TTL_MS. Called on list mount and on every record. */
export function pruneExpiredGhosts(nowMs = dayjs().valueOf()): void {
    const expiredIds = [...ghostsByItemId.entries()].filter(([, entry]) => nowMs - entry.recordedAtMs > GHOST_TTL_MS).map(([id]) => id);
    if (expiredIds.length === 0) {
        return;
    }
    for (const id of expiredIds) {
        ghostsByItemId.delete(id);
    }
    notifyGhostListeners();
}

export function subscribeToGhosts(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function getGhostSnapshots(): StoredItem[] {
    return ghostSnapshotCache;
}

export function resetGhostStore(): void {
    ghostsByItemId.clear();
    ghostSnapshotCache = [];
}

/**
 * Inserts each ghost right after its live counterpart (same `_id`), so a page's stable
 * sort keeps the ghost in the row's old position; ghosts of hard-deleted items (no live
 * counterpart) append at the end. Both entries stay in the array — a page's status
 * filter keeps at most one, since a ghost's status always differs from its live item's.
 */
export function mergeGhostsIntoItems(liveItems: StoredItem[], ghostItems: StoredItem[]): StoredItem[] {
    if (ghostItems.length === 0) {
        return liveItems;
    }
    const unmatchedGhostsById = new Map(ghostItems.map((ghost) => [ghost._id, ghost]));
    const merged = liveItems.flatMap((item) => {
        const ghost = unmatchedGhostsById.get(item._id);
        if (!ghost) {
            return [item];
        }
        unmatchedGhostsById.delete(item._id);
        return [item, ghost];
    });
    return [...merged, ...unmatchedGhostsById.values()];
}
