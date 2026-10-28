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
 * done item's `statusBeforeDone` (`stampStatusBeforeDone`, which also stamps it on completion). One
 * stored-row read per item op serves all three. Rewrites `op.snapshot` in place and MUST run before
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
    const withRank = stampStatusBeforeDone(existing, carryForwardRank(existing, op.snapshot));
    op.snapshot = opts.skipCalendarLink ? withRank : carryForwardCalendarLink(existing, withRank);
}
