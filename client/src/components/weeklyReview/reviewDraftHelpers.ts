import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import type { MyDB, StoredWeeklyReviewDraft } from '../../types/MyDB';
import { isReviewStageId, REVIEW_STAGES, type ReviewFlowState, type ReviewStageId, type StageDecision, type StageQueue } from './reviewFlowState';

/** Device-local persistence for an in-progress weekly review — same drafts store the inbox capture field uses. */

export function weeklyReviewDraftKey(userId: string): string {
    return `weeklyReview:${userId}`;
}

export async function getWeeklyReviewDraft(db: IDBPDatabase<MyDB>, userId: string): Promise<ReviewFlowState | undefined> {
    const draft = await db.get('drafts', weeklyReviewDraftKey(userId));
    return draft?.kind === 'weeklyReview' ? flowFromDraft(draft) : undefined;
}

export async function saveWeeklyReviewDraft(db: IDBPDatabase<MyDB>, userId: string, flow: ReviewFlowState): Promise<void> {
    await db.put('drafts', {
        key: weeklyReviewDraftKey(userId),
        kind: 'weeklyReview',
        userId,
        updatedTs: dayjs().toISOString(),
        flow: {
            stageIndex: flow.stageIndex,
            tickedInboxIds: flow.tickedInboxIds,
            queues: flow.queues,
            skippedStageIds: flow.skippedStageIds,
            startedTs: flow.startedTs,
        },
    });
}

export async function deleteWeeklyReviewDraft(db: IDBPDatabase<MyDB>, userId: string): Promise<void> {
    await db.delete('drafts', weeklyReviewDraftKey(userId));
}

/**
 * The stored shape is structurally identical to ReviewFlowState but string-keyed (MyDB stays free
 * of component imports). Unknown stage ids — a draft written by a build with a different stage
 * list — are dropped rather than resumed into a stage that no longer exists.
 */
function flowFromDraft(draft: StoredWeeklyReviewDraft): ReviewFlowState {
    const queues: Partial<Record<ReviewStageId, StageQueue>> = {};
    for (const [stageId, queue] of Object.entries(draft.flow.queues)) {
        if (isReviewStageId(stageId) && queue) {
            // A stored cursor (written as part of the whole-flow snapshot) is deliberately
            // IGNORED: stage entry always restarts the walk at the first undecided item, and
            // honouring it here would only flash that item for a frame before the wizard's entry
            // effect resets it. Pre-cursor drafts (which rotated the pending list) land here too.
            // `droppedIds` is deliberately not restored for the same reason: resume is a stage
            // re-entry, which clears the per-visit drop list and re-offers dropped items anyway.
            queues[stageId] = { pending: queue.pending, cursor: 0, decisions: coerceDraftDecisions(queue) };
        }
    }
    return {
        // Clamp into the current stage range: a draft from a build with a different stage list
        // must resume inside it — an index past the end reads as "complete" and renders a blank
        // wizard with no controls (and no draft write ever heals it).
        stageIndex: Math.min(Math.max(draft.flow.stageIndex, 0), REVIEW_STAGES.length - 1),
        tickedInboxIds: draft.flow.tickedInboxIds,
        queues,
        skippedStageIds: draft.flow.skippedStageIds.filter(isReviewStageId),
        startedTs: draft.flow.startedTs,
    };
}

type StoredDraftQueue = NonNullable<StoredWeeklyReviewDraft['flow']['queues'][string]>;

/**
 * Coerces every historical decision shape to the current one. Flat `undoSnapshot` was this
 * feature's first (unshipped) shape — same meaning as `undo.snapshot`. Older drafts stored
 * `processedIds` (or only a count before that): those become undo-less decisions — revisiting
 * still works, one-click undo just isn't offered.
 */
function coerceDraftDecisions(queue: StoredDraftQueue): StageDecision[] {
    if (!queue.decisions) {
        return (queue.processedIds ?? []).map((itemId) => ({ itemId }));
    }
    return queue.decisions.map(({ itemId, undo, undoSnapshot }) => ({
        itemId,
        ...(undo ? { undo } : undoSnapshot ? { undo: { snapshot: undoSnapshot } } : {}),
    }));
}

/** Last-completed marker — survives review resets, keyed per user, local-only. */
const lastCompletedKey = (userId: string) => `gtd:weeklyReview:lastCompleted:${userId}`;

export function getLastCompletedTs(userId: string): string | null {
    try {
        return localStorage.getItem(lastCompletedKey(userId));
    } catch {
        return null;
    }
}

export function setLastCompletedTs(userId: string, ts: string): void {
    try {
        localStorage.setItem(lastCompletedKey(userId), ts);
    } catch {
        // Storage unavailable (private mode) — the completion banner just won't show a date.
    }
}
