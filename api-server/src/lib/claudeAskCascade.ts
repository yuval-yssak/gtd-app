import dayjs from 'dayjs';
import claudeAsksDAO from '../dataAccess/claudeAsksDAO.js';
import { notifyChange } from './notifyChange.js';
import { recordOperation } from './operationHelpers.js';

const DEVICE_ID = 'server:claude-ask-cascade';

/**
 * Removes every Claude ask of an item that is leaving a user's account — hard delete or
 * cross-account reassign — and records one `claudeAsk` delete op per row so devices drop their
 * copies. The asks never move with a reassigned item: they record sessions on the SOURCE
 * account's Claude routine. Trash and done keep them (those are item updates, not deletes).
 *
 * Uses recordOperation + notifyChange rather than `applyAndPublishOperation` for the same reason
 * as `cascadeItemBriefRemoval`: the full pipeline would close an import cycle through
 * `referenceCascades.ts`. No-op when the item never had an ask.
 */
export async function cascadeClaudeAskRemoval(userId: string, itemId: string): Promise<void> {
    const asks = await claudeAsksDAO.findArray({ user: userId, itemId });
    for (const ask of asks) {
        await removeClaudeAsk(userId, ask._id);
    }
}

async function removeClaudeAsk(userId: string, askId: string): Promise<void> {
    await claudeAsksDAO.deleteByOwner(askId, userId);
    const op = await recordOperation(userId, {
        entityType: 'claudeAsk',
        entityId: askId,
        opType: 'delete',
        snapshot: null,
        now: dayjs().toISOString(),
        deviceId: DEVICE_ID,
    });
    await notifyChange(op, {});
}
