import { cascadeClaudeAskRemoval } from './claudeAskCascade.js';
import { cascadeItemBriefRemoval } from './itemBriefCascade.js';

/**
 * Drops every per-item sidecar — the brief and the Claude asks — of an item leaving a user's
 * account (hard delete, cross-account reassign, operator scripts). The one place a new per-item
 * sidecar has to be added. Each cascade runs on its own, so one failing cannot strand the other's
 * rows; both are idempotent (no-op without rows), which the reassign already-moved heal relies on.
 */
export async function cascadeItemSidecarRemoval(userId: string, itemId: string): Promise<void> {
    const results = await Promise.allSettled([cascadeItemBriefRemoval(userId, itemId), cascadeClaudeAskRemoval(userId, itemId)]);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) {
        throw failure.reason;
    }
}
