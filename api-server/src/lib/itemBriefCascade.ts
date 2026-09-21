import dayjs from 'dayjs';
import itemBriefsDAO from '../dataAccess/itemBriefsDAO.js';
import { notifyChange } from './notifyChange.js';
import { recordOperation } from './operationHelpers.js';

const DEVICE_ID = 'server:brief-cascade';

/**
 * Removes the brief sidecar of an item that is leaving a user's account — hard delete or
 * cross-account reassign — and records the `itemBrief` delete op so every device drops its
 * copy. The brief never moves with a reassigned item: the target's sweeper regenerates it from
 * the moved content, and an authored brief describes a commitment the source user held.
 *
 * Uses the same DAO + recordOperation + notifyChange primitives as the person/workContext
 * reference cascade (not `applyAndPublishOperation`, which would close an import cycle through
 * `referenceCascades.ts`). No-op when the item never had a brief.
 *
 * ⚠️ ORDERING INVARIANT: unlike `clearBrief`, this deliberately does NOT re-mark the item's
 * `briefStale` (`lib/brief/briefStaleMarker.ts`) — every caller must already have made the item
 * unreachable by the sweep or re-marked it. Today: the hard-delete path has removed the row
 * entirely, and the reassign path runs `applyAndPublishOwnerMove` (→ `replaceByOwner`, which marks
 * the target row) BEFORE deleting the source brief. A new caller that leaves a live, settled item
 * behind would strand it with no brief and no marker — mark it, or delete the item first.
 */
export async function cascadeItemBriefRemoval(userId: string, itemId: string): Promise<void> {
    const existing = await itemBriefsDAO.findByOwnerAndId(itemId, userId);
    if (!existing) {
        return;
    }
    await itemBriefsDAO.deleteByOwner(itemId, userId);
    const op = await recordOperation(userId, {
        entityType: 'itemBrief',
        entityId: itemId,
        opType: 'delete',
        snapshot: null,
        now: dayjs().toISOString(),
        deviceId: DEVICE_ID,
    });
    await notifyChange(op, {});
}
