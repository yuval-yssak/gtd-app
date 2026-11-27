import itemsDAO from '../dataAccess/itemsDAO.js';
import type { ItemInterface, OperationInterface } from '../types/entities.js';
import { carryForwardCalendarLink } from './calendarLinkCarryForward.js';
import { carryForwardRank } from './rankCarryForward.js';
import { dropStatusBeforeDoneIfOpen, stampStatusBeforeDone } from './statusBeforeDone.js';

export interface ItemCarryForwardOptions {
    /** See `ApplyOptions.skipCalendarLinkCarryForward`. The rank carry-forward is never skipped. */
    skipCalendarLink?: boolean | undefined;
}

type ItemSnapshotOp = OperationInterface & { snapshot: ItemInterface };

/**
 * Apply-pipeline hydrator for the server-owned item fields a client snapshot may lack because the
 * device has not pulled them yet: the Google link + sync anchors (`carryForwardCalendarLink`, which
 * itself declines detach statuses), the priority `rank` (`carryForwardRank`, every status) and the
 * done item's `statusBeforeDone` (`stampStatusBeforeDone`, which also stamps it on completion). The
 * same stored-row read marks an edit of an already-trashed row (`op.rowAlreadyTrash`) for pushback.
 * One stored-row read per item op serves all of them. Rewrites `op.snapshot` in place and MUST run before
 * `applyEntityOp` overwrites the row. Not gated on last-write-wins: a stale op is not applied
 * anyway, and a merged stale snapshot is harmless to replay. The read here and the `replaceById`
 * in `applyEntityOp` are not atomic — a link stamp landing in between is still overwritten; that
 * millisecond window is closed from the other side by `pushStateReachedDuringCreate` in
 * calendarPushback.ts, which re-pushes the row's state after the stamp.
 */
export async function hydrateItemCarryForwards(userId: string, ops: OperationInterface[], opts: ItemCarryForwardOptions = {}): Promise<void> {
    const targets = ops.filter(isItemSnapshotOp);
    if (!targets.length) {
        return;
    }
    await Promise.all(targets.map((op) => carryForwardOne(userId, op, opts)));
    markRepeatTrashWithinBatch(targets);
}

/**
 * Every op above compared against the row as it stood BEFORE the batch, so an edit queued behind
 * a trash of the same item (an offline "missed", then a notes fix) still looks like the move into
 * trash. Within the batch the previous same-item op is the row the later one lands on: queue order.
 */
function markRepeatTrashWithinBatch(ops: ReadonlyArray<ItemSnapshotOp>): void {
    ops.forEach((op, index) => {
        const previous = ops.slice(0, index).findLast((earlier) => earlier.entityId === op.entityId);
        if (previous?.snapshot.status === 'trash' && op.snapshot.status === 'trash') {
            op.rowAlreadyTrash = true;
        }
    });
}

/** An edit of an already-trashed row: see `OperationInterface.rowAlreadyTrash`. */
function markRepeatTrash(existing: ItemInterface, op: ItemSnapshotOp): void {
    if (existing.status === 'trash' && op.snapshot.status === 'trash') {
        op.rowAlreadyTrash = true;
    }
}

function isItemSnapshotOp(op: OperationInterface): op is ItemSnapshotOp {
    return op.entityType === 'item' && (op.opType === 'create' || op.opType === 'update') && op.snapshot !== null;
}

async function carryForwardOne(userId: string, op: ItemSnapshotOp, opts: ItemCarryForwardOptions): Promise<void> {
    const existing = await itemsDAO.findByOwnerAndId(op.entityId, userId);
    if (!existing) {
        // A create (or an update of a missing row) still must not plant a completion record on an open item.
        op.snapshot = dropStatusBeforeDoneIfOpen(op.snapshot);
        return;
    }
    markRepeatTrash(existing, op);
    const withRank = stampStatusBeforeDone(existing, carryForwardRank(existing, op.snapshot));
    op.snapshot = opts.skipCalendarLink ? withRank : carryForwardCalendarLink(existing, withRank);
}
