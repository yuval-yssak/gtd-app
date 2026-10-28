import type { ItemInterface, OpenItemStatus } from '../types/entities.js';

const isOpenStatus = (status: ItemInterface['status']): status is OpenItemStatus => status !== 'done' && status !== 'trash';

/**
 * Keeps `statusBeforeDone` true on every item write that has a stored row. Only a done row (or a
 * trashed done row) may hold it: an open snapshot, or a trash snapshot over an open row (a trashed
 * open item was never done), drops it — so no open row ever holds a stale value that a snapshot
 * rebuilt from the row could echo into the next completion. A done snapshot's own value wins: the
 * client stamps it at completion, and its queue collapses consecutive updates (inbox → calendar →
 * done can arrive as ONE op while the stored row is still inbox), so only the device knows. A done
 * snapshot without one (POST /complete, PATCH, a batch op, an older client) takes the stored open
 * status, or on a done → done / trash edit the stored value (the device has not pulled it, and the
 * whole-document apply would otherwise erase it). Mirrored by `client/src/db/itemMutations.ts`.
 */
export function stampStatusBeforeDone(existing: ItemInterface, incoming: ItemInterface): ItemInterface {
    // Trade-off: an offline inbox → done → trash collapsed into ONE trash op loses its (correct)
    // record here — accepted, it fails safe and only affects an item already in the trash.
    if (isOpenStatus(incoming.status) || (incoming.status === 'trash' && isOpenStatus(existing.status))) {
        return withoutStatusBeforeDone(incoming);
    }
    if (incoming.statusBeforeDone !== undefined) {
        return incoming;
    }
    const recorded = incoming.status === 'done' && isOpenStatus(existing.status) ? existing.status : existing.statusBeforeDone;
    return recorded ? { ...incoming, statusBeforeDone: recorded } : incoming;
}

/** An open item holds no completion record — used where there is no stored row, and by snapshots rebuilt from one. */
export function withoutStatusBeforeDone(item: ItemInterface): ItemInterface {
    if (item.statusBeforeDone === undefined) {
        return item;
    }
    const { statusBeforeDone: _dropped, ...rest } = item;
    return rest;
}

/** The create-op half of the rule: with no stored row, only an open snapshot's field is knowably wrong. */
export function dropStatusBeforeDoneIfOpen(item: ItemInterface): ItemInterface {
    return isOpenStatus(item.status) ? withoutStatusBeforeDone(item) : item;
}
