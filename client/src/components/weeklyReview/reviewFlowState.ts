import { compareNextActions } from '../../lib/compareNextActions';
import { flattenByPersonGroups } from '../../lib/waitingForGroups';
import type { StoredItem } from '../../types/MyDB';
import { compareCalendarItems } from '../calendarRouteSort';

/**
 * Pure model of the weekly-review wizard: stage definitions, per-stage item eligibility, and the
 * solo-item queue with Marie Kondo semantics (decide now, or consciously skip past — the walk is
 * linear and ends). Kept free of React and IDB so every transition is unit-testable.
 */

export const REVIEW_STAGE_IDS = ['clearInboxes', 'clarify', 'calendar', 'nextActions', 'waitingFor', 'tickler', 'somedayMaybe', 'finalSweep'] as const;
export type ReviewStageId = (typeof REVIEW_STAGE_IDS)[number];

export type ReviewStageKind = 'checklist' | 'clarify' | 'focus';

export interface ReviewStageDefinition {
    id: ReviewStageId;
    kind: ReviewStageKind;
    title: string;
    /** One-line coaching text shown under the stage title. */
    guidance: string;
}

export const REVIEW_STAGES: ReadonlyArray<ReviewStageDefinition> = [
    {
        id: 'clearInboxes',
        kind: 'checklist',
        title: 'Clear all inboxes',
        guidance: 'Empty every capture bucket — tick each one off as it reaches zero. New thoughts go straight into the inbox.',
    },
    { id: 'clarify', kind: 'clarify', title: 'Clarify', guidance: 'Decide what each captured item is and what to do about it — one at a time.' },
    { id: 'calendar', kind: 'focus', title: 'Calendar', guidance: 'Undone calendar entries, past and future — mark done, reschedule, or capture follow-ups.' },
    { id: 'nextActions', kind: 'focus', title: 'Next Actions', guidance: 'Still the right next step? Mark done, defer, or re-clarify.' },
    { id: 'waitingFor', kind: 'focus', title: 'Waiting For', guidance: 'Has it arrived? Does someone need a nudge?' },
    { id: 'tickler', kind: 'focus', title: 'Tickler', guidance: 'Snoozed items — is the wake-up date still right, or is it time to release one?' },
    { id: 'somedayMaybe', kind: 'focus', title: 'Someday / Maybe', guidance: 'Anything here ready to become real? Anything to let go of?' },
    {
        id: 'finalSweep',
        kind: 'clarify',
        title: 'Final sweep',
        guidance: 'Reviewing generates new thoughts — clarify everything that landed in the inbox on the way.',
    },
];

/** Reference data eligibility reads besides the items themselves — kept as inputs so it stays pure. */
export interface StageEligibilityContext {
    /** YYYY-MM-DD — passed in (never read from the clock here). */
    todayIso: string;
    /** Person id → display name; drives the waitingFor stage's person-grouped page order. */
    personNameById: Record<string, string>;
}

/**
 * The items a stage reviews, in presentation order — each stage walks its items in the EXACT
 * order its own list page renders them (in that page's default view), so the review reads like
 * scanning that page top to bottom.
 */
export function stageEligibleItems(stageId: ReviewStageId, items: ReadonlyArray<StoredItem>, context: StageEligibilityContext): StoredItem[] {
    const { todayIso, personNameById } = context;
    switch (stageId) {
        case 'clearInboxes':
            return [];
        case 'clarify':
        case 'finalSweep':
            // Newest-first (LIFO), matching the /inbox page.
            return items.filter((item) => item.status === 'inbox').sort((a, b) => b.createdTs.localeCompare(a.createdTs));
        case 'calendar':
            // "Undone" = still status:calendar — a completed entry became done. Past AND future
            // both qualify (per design: only done-ness excludes an entry, not its date).
            // compareCalendarItems is the /calendar page's rendered order flattened.
            return items.filter((item) => item.status === 'calendar').sort(compareCalendarItems);
        case 'nextActions':
            // Same comparator as the Next Actions page (focus first, then expectedBy tiers).
            return items.filter((item) => item.status === 'nextAction' && !isTicklerHidden(item, todayIso)).sort(compareNextActions);
        case 'waitingFor':
            // The /waiting-for page's default view: expectedBy ascending (undated first, '' sorts
            // before any date), then grouped by person A→Z with Unassigned last, flattened.
            return flattenByPersonGroups(
                items
                    .filter((item) => item.status === 'waitingFor' && !isTicklerHidden(item, todayIso))
                    .sort((a, b) => (a.expectedBy ?? '').localeCompare(b.expectedBy ?? '')),
                personNameById,
            );
        case 'tickler':
            // Mirrors the /tickler page: only nextAction + waitingFor participate in the tickler.
            return items
                .filter((item) => (item.status === 'nextAction' || item.status === 'waitingFor') && isTicklerHidden(item, todayIso))
                .sort((a, b) => (a.ignoreBefore ?? '').localeCompare(b.ignoreBefore ?? ''));
        case 'somedayMaybe':
            // Newest-first, matching the /someday page.
            return items.filter((item) => item.status === 'somedayMaybe').sort((a, b) => b.createdTs.localeCompare(a.createdTs));
    }
}

function isTicklerHidden(item: StoredItem, todayIso: string): boolean {
    return item.ignoreBefore !== undefined && item.ignoreBefore > todayIso;
}

// ── Solo-item queue ──────────────────────────────────────────────────────────

/**
 * How a decision can be reversed. `snapshot` is the item as it was the moment before the
 * decision's write; a present-but-empty undo marks a no-write decision ("Looks good") whose
 * reversal is just a requeue.
 */
export interface StageDecisionUndo {
    snapshot?: StoredItem;
}

/** One decision made in a stage (done/kept/released/trashed/edited — anything but skip). */
export interface StageDecision {
    itemId: string;
    /**
     * Present iff the decision is reversible; the "Undo decision" button renders exactly on this.
     * Deliberately absent for routine-generated items (their disposal already advanced the
     * routine's series — a snapshot restore would double-book it), for clarify-to-routine (a
     * compound write: routine + seeded items + item trash — a bare snapshot restore would orphan
     * the routine), and for decisions coerced from legacy drafts.
     */
    undo?: StageDecisionUndo;
}

export interface StageQueue {
    /** Undecided item ids in presentation order — a skipped id stays in place (no reordering). */
    pending: string[];
    /**
     * Index of the current item within `pending`. `pending.length` means past the end: the walk
     * is LINEAR and ends at the stage-end card (▶ never cycles back to the beginning).
     */
    cursor: number;
    /**
     * Decisions made in this stage, oldest first. Entries (not a bare id list) so the back arrow
     * can revisit each decision and offer its undo; ids alone still drive revisit dedupe.
     */
    decisions: StageDecision[];
    /**
     * Ids removed from THIS visit's walk without a decision (a blocked item dropped via the
     * escape hatch, or an undo whose deferred requeue is still in flight). The live-append
     * reconcile must not re-offer these mid-stage; a stage re-entry clears the list and offers
     * them again. Optional: absent on queues persisted before the field existed.
     */
    droppedIds?: string[];
}

export function buildStageQueue(itemIds: ReadonlyArray<string>): StageQueue {
    return { pending: [...itemIds], cursor: 0, decisions: [] };
}

/** Ids decided in this stage, in decision order. */
export function decidedItemIds(queue: StageQueue): string[] {
    return queue.decisions.map((decision) => decision.itemId);
}

/** The current solo item, or null when the queue is empty or the cursor walked past the end. */
export function currentQueueItemId(queue: StageQueue): string | null {
    return queue.pending[queue.cursor] ?? null;
}

/**
 * A decision was made on the current item — it leaves the queue for good (unless undone). The
 * cursor stays put, so it now points at the next undecided item (or past the end).
 */
export function completeCurrentItem(queue: StageQueue, undo?: StageDecisionUndo): StageQueue {
    const current = queue.pending[queue.cursor];
    if (current === undefined) {
        return queue;
    }
    return {
        ...queue,
        pending: queue.pending.filter((_, index) => index !== queue.cursor),
        decisions: [...queue.decisions, { itemId: current, ...(undo ? { undo } : {}) }],
    };
}

/** Drops one decision from the history without touching `pending` — phase 1 of a snapshot undo. */
export function removeDecision(queue: StageQueue, itemId: string): StageQueue {
    const decisions = queue.decisions.filter((decision) => decision.itemId !== itemId);
    return decisions.length === queue.decisions.length ? queue : { ...queue, decisions };
}

/**
 * Marks an id as excluded from the live-append reconcile without recording a decision — phase 1
 * of a snapshot undo parks the id here so the reconcile can't re-offer it at the END of the walk
 * during the gap before the deferred requeue lands. Cleared by `requeueAtCursor` and on stage
 * re-entry.
 */
export function excludeFromLiveAppend(queue: StageQueue, itemId: string): StageQueue {
    const droppedIds = queue.droppedIds ?? [];
    return droppedIds.includes(itemId) ? queue : { ...queue, droppedIds: [...droppedIds, itemId] };
}

/** Lifts an id off the live-append exclusion list; same reference when it was not on it. */
function withoutLiveAppendExclusion(queue: StageQueue, itemId: string): StageQueue {
    const droppedIds = (queue.droppedIds ?? []).filter((id) => id !== itemId);
    return droppedIds.length === (queue.droppedIds ?? []).length ? queue : { ...queue, droppedIds };
}

/** Moves an id to the cursor slot — inserting it, or relocating it from elsewhere in pending. */
function placeAtCursor(queue: StageQueue, itemId: string): StageQueue {
    const existingIndex = queue.pending.indexOf(itemId);
    const pendingWithout = existingIndex >= 0 ? queue.pending.filter((id) => id !== itemId) : queue.pending;
    // Removing an id from BEFORE the cursor shifts the target slot one left; clamp past-the-end.
    const removedBeforeCursor = existingIndex >= 0 && existingIndex < queue.cursor ? 1 : 0;
    const cursor = Math.min(queue.cursor - removedBeforeCursor, pendingWithout.length);
    return { ...queue, cursor, pending: [...pendingWithout.slice(0, cursor), itemId, ...pendingWithout.slice(cursor)] };
}

/**
 * Returns an undone id to the CURSOR position so the item renders as the current live item again
 * — phase 2 of a snapshot undo. No-op if the id was (re-)decided in the meantime, so a late
 * deferred requeue can never duplicate a decision. An id that is already pending but NOT at the
 * cursor is MOVED there (a racing live-append may have queued it at the end first), and the id
 * leaves the live-append exclusion list.
 */
export function requeueAtCursor(queue: StageQueue, itemId: string): StageQueue {
    if (decidedItemIds(queue).includes(itemId)) {
        return queue;
    }
    const lifted = withoutLiveAppendExclusion(queue, itemId);
    if (lifted === queue && queue.pending[queue.cursor] === itemId) {
        return queue;
    }
    return placeAtCursor(lifted, itemId);
}

/**
 * Reverses a decision made this stage in one step: the entry leaves the decision history and its
 * id returns to the cursor position of the pending queue. Used directly for no-write undos;
 * snapshot undos run the two phases separately (see useDecisionUndo). Restoring the data snapshot
 * is the caller's job — this is pure queue bookkeeping.
 */
export function undoDecision(queue: StageQueue, itemId: string): StageQueue {
    const withoutDecision = removeDecision(queue, itemId);
    return withoutDecision === queue ? queue : requeueAtCursor(withoutDecision, itemId);
}

/**
 * Whether a snapshot undo's deferred phase-2 requeue may run: `wait` until the shared items
 * snapshot shows the restored write, `abort` if the row vanished entirely (hard-deleted
 * mid-restore — waiting would never resolve). ISO-string comparison is valid for `updatedTs`.
 */
export function requeueReadiness(row: StoredItem | undefined, restoredTs: string): 'wait' | 'requeue' | 'abort' {
    if (!row) {
        return 'abort';
    }
    return row.updatedTs < restoredTs ? 'wait' : 'requeue';
}

/**
 * Conscious skip: step PAST the current item, leaving it undecided in place — the ▶ arrow and
 * Escape-close behavior. The walk is linear and ends at the stage-end card (cursor ==
 * pending.length); it never cycles back to the beginning. Skipped items are re-offered on the
 * next stage entry.
 */
export function skipCurrentItem(queue: StageQueue): StageQueue {
    if (queue.cursor >= queue.pending.length) {
        return queue;
    }
    return { ...queue, cursor: queue.cursor + 1 };
}

/** The ◀ inverse of a ▶ skip: step back to the previously skipped item. Same reference at the start. */
export function stepBack(queue: StageQueue): StageQueue {
    if (queue.cursor <= 0) {
        return queue;
    }
    return { ...queue, cursor: queue.cursor - 1 };
}

/**
 * Remove the current item WITHOUT recording a decision — for an item that can't be acted on right
 * now (a reassign in flight freezes its editor). Unlike a completion it doesn't count as
 * reviewed: a stage re-entry re-offers the item if it is still eligible.
 */
export function dropCurrentItem(queue: StageQueue): StageQueue {
    const current = queue.pending[queue.cursor];
    if (current === undefined) {
        return queue;
    }
    // Recorded in droppedIds so the live-append reconcile can't immediately re-offer the (still
    // eligible) item it just escaped from — only a stage re-entry brings it back.
    return { ...queue, pending: queue.pending.filter((_, index) => index !== queue.cursor), droppedIds: [...(queue.droppedIds ?? []), current] };
}

/** The stage-end card's per-stage wording — the skipped count always prefixes with `stageName`. */
export interface StageEndLabels {
    /** Display name prefixing the "N skipped" variant. */
    stageName: string;
    /** Every queued item decided. */
    allReviewed: string;
    /** The stage never had anything to offer. */
    empty: string;
}

/**
 * Stage-end card title — reached by deciding everything, by ▶-walking past the rest, or by the
 * stage being empty from the start. Skipped-past items are called out so ending the walk never
 * reads as having reviewed them.
 */
export function stageEndTitle(labels: StageEndLabels, queue: StageQueue): string {
    if (queue.pending.length > 0) {
        return `${labels.stageName} — ${queue.pending.length} skipped`;
    }
    return queue.decisions.length > 0 ? labels.allReviewed : labels.empty;
}

/**
 * Shared filter+append core of the reconcile pair: keeps still-eligible pending ids in order,
 * appends eligible ids that are neither queued, decided, nor in `excludedNewcomers`, and keeps
 * the cursor on the same item. The clamp runs BEFORE appending, so an end-card cursor lands
 * exactly on the first appended arrival. Same reference when nothing changed.
 */
function mergeQueueWithEligible(queue: StageQueue, eligibleIds: ReadonlyArray<string>, excludedNewcomers: ReadonlySet<string>): StageQueue {
    const eligible = new Set(eligibleIds);
    const keptPending = queue.pending.filter((id) => eligible.has(id));
    const alreadyQueued = new Set([...queue.pending, ...decidedItemIds(queue)]);
    const newcomers = eligibleIds.filter((id) => !alreadyQueued.has(id) && !excludedNewcomers.has(id));
    if (keptPending.length === queue.pending.length && newcomers.length === 0) {
        return queue;
    }
    // Keep the cursor on the same item (or its successor): shift it left by however many removed
    // ids preceded it.
    const removedBeforeCursor = queue.pending.slice(0, queue.cursor).filter((id) => !eligible.has(id)).length;
    const cursor = Math.min(queue.cursor - removedBeforeCursor, keptPending.length);
    return { ...queue, pending: [...keptPending, ...newcomers], cursor };
}

/**
 * Mid-stage reconcile: drops queue entries that no longer qualify — the item was completed on
 * another device, or resumed state references ids that have since changed status — and APPENDS
 * newly-eligible arrivals at the end of the walk (per design: items added while a stage is being
 * reviewed join it live; the "12 of 34" total grows). Ids the user removed from this visit's walk
 * without deciding (`droppedIds`) are never re-offered mid-stage. A user parked on the stage-end
 * card is handed the first appended newcomer as the new current item.
 */
export function reconcileQueue(queue: StageQueue, eligibleIds: ReadonlyArray<string>): StageQueue {
    return mergeQueueWithEligible(queue, eligibleIds, new Set(queue.droppedIds ?? []));
}

/**
 * Stage (re-)entry queue: still-eligible pending ids keep their order, then anything eligible
 * that has neither been decided nor queued yet is appended — so revisiting a stage offers exactly
 * the undecided leftovers plus new arrivals (e.g. captures made since the stage was first entered),
 * never items already decided this review. Entry clears the per-visit `droppedIds` (dropped items
 * are consciously re-offered) and always restarts the walk at the first undecided item (cursor 0).
 * Returns the same reference when nothing changed.
 */
export function refreshQueueOnEntry(queue: StageQueue | undefined, eligibleIds: ReadonlyArray<string>): StageQueue {
    if (!queue) {
        return buildStageQueue(eligibleIds);
    }
    const merged = mergeQueueWithEligible(queue, eligibleIds, new Set());
    if (merged === queue && queue.cursor === 0 && (queue.droppedIds?.length ?? 0) === 0) {
        return queue;
    }
    return { ...merged, cursor: 0, droppedIds: [] };
}

// ── Whole-flow state ─────────────────────────────────────────────────────────

export interface ReviewFlowState {
    stageIndex: number;
    /** Ticked-off user-defined inbox ids in the clearInboxes checklist. */
    tickedInboxIds: string[];
    /** Lazily created on first entry to each stage; keyed by stage id. */
    queues: Partial<Record<ReviewStageId, StageQueue>>;
    /** Stages the user skipped wholesale. */
    skippedStageIds: ReviewStageId[];
    startedTs: string;
}

/**
 * Functional flow update. Queue-affecting callers MUST use this form: two same-tick commits (the
 * deferred undo requeue and the wizard's reconcile both wake on the same items change) would
 * otherwise each replace the flow from their own render's stale copy, silently clobbering one
 * another. The route resolves updaters against the latest flow (see weekly-review.tsx).
 */
export type ReviewFlowUpdater = (prev: ReviewFlowState) => ReviewFlowState;

export function startReviewFlow(startedTs: string): ReviewFlowState {
    return { stageIndex: 0, tickedInboxIds: [], queues: {}, skippedStageIds: [], startedTs };
}

export function currentStage(state: ReviewFlowState): ReviewStageDefinition | null {
    return REVIEW_STAGES[state.stageIndex] ?? null;
}

export function isFlowComplete(state: ReviewFlowState): boolean {
    return state.stageIndex >= REVIEW_STAGES.length;
}

export function advanceStage(state: ReviewFlowState): ReviewFlowState {
    return { ...state, stageIndex: state.stageIndex + 1 };
}

export function skipStage(state: ReviewFlowState): ReviewFlowState {
    const stage = currentStage(state);
    if (!stage) {
        return state;
    }
    // Dedupe: with free timeline jumps a stage can be skipped, revisited, and skipped again.
    const skippedStageIds = state.skippedStageIds.includes(stage.id) ? state.skippedStageIds : [...state.skippedStageIds, stage.id];
    return { ...advanceStage(state), skippedStageIds };
}

/** Free timeline navigation: jump to any stage, no skip marks, clamped into the stage range. */
export function jumpToStage(state: ReviewFlowState, stageIndex: number): ReviewFlowState {
    return { ...state, stageIndex: Math.min(Math.max(stageIndex, 0), REVIEW_STAGES.length - 1) };
}

export function isReviewStageId(value: unknown): value is ReviewStageId {
    return typeof value === 'string' && (REVIEW_STAGE_IDS as ReadonlyArray<string>).includes(value);
}

/** Precondition: `stageId` is a known stage (guard with `isReviewStageId` first) — returns -1 otherwise. */
export function stageIndexOf(stageId: ReviewStageId): number {
    return REVIEW_STAGES.findIndex((stage) => stage.id === stageId);
}

/** Whether the clearInboxes checklist is fully ticked: every listed external bucket. */
export function isChecklistComplete(tickedInboxIds: ReadonlyArray<string>, inboxIds: ReadonlyArray<string>): boolean {
    return inboxIds.every((id) => tickedInboxIds.includes(id));
}

export function toggleInboxTick(state: ReviewFlowState, inboxId: string): ReviewFlowState {
    const isTicked = state.tickedInboxIds.includes(inboxId);
    return { ...state, tickedInboxIds: isTicked ? state.tickedInboxIds.filter((id) => id !== inboxId) : [...state.tickedInboxIds, inboxId] };
}

export function withStageQueue(state: ReviewFlowState, stageId: ReviewStageId, queue: StageQueue): ReviewFlowState {
    return { ...state, queues: { ...state.queues, [stageId]: queue } };
}

export interface StageArrival {
    stageId: ReviewStageId;
    title: string;
    count: number;
}

/**
 * Ids decided in FOCUS stages this review. A focus decision (snooze, release, done) consciously
 * chose the item's new list placement, so re-offering it in the sweep would second-guess the
 * user's seconds-old decision. A CLARIFY decision is different: it determined what the item IS,
 * but the resulting list entry was never reviewed in its list's context — so clarify-decided ids
 * deliberately stay eligible as arrivals for the focus stage they landed in.
 */
function focusStageDecidedIds(state: ReviewFlowState): Set<string> {
    return new Set(
        REVIEW_STAGES.filter((stage) => stage.kind === 'focus').flatMap((stage) => {
            const queue = state.queues[stage.id];
            return queue ? decidedItemIds(queue) : [];
        }),
    );
}

/** Eligible items a visited stage never offered: not queued, not decided there, not dropped, not focus-decided elsewhere. */
function stageArrivalCount(queue: StageQueue, eligible: ReadonlyArray<StoredItem>, settledIds: ReadonlySet<string>): number {
    // droppedIds count as seen: a blocked item consciously dropped from the walk was offered —
    // the sweep surfaces only items the user never saw in this stage.
    const seenIds = new Set([...queue.pending, ...decidedItemIds(queue), ...(queue.droppedIds ?? [])]);
    return eligible.filter((item) => !seenIds.has(item._id) && !settledIds.has(item._id)).length;
}

// The `clarify` stage is excluded from the sweep scan: it shares the inbox eligibility with
// finalSweep, which is by definition the review's inbox catcher — scanning both would report
// every late capture twice and jump the user back to stage 2 for it.
const SWEPT_STAGES: ReadonlyArray<ReviewStageDefinition> = REVIEW_STAGES.filter((stage) => stage.kind === 'focus' || stage.id === 'finalSweep');

/**
 * Pre-celebration sweep: stages the user already worked through that have since gained eligible
 * items they never saw (a queued-but-skipped item was consciously offered and does not count).
 * Stages without a queue were bypassed wholesale via timeline jumps; treating their entire
 * content as "arrivals" would block every fast-forwarded review, so they are excluded — the
 * completion stats already call them out as skipped. Returned in stage order, so the earliest
 * stale stage leads.
 */
export function unreviewedStageArrivals(state: ReviewFlowState, items: ReadonlyArray<StoredItem>, context: StageEligibilityContext): StageArrival[] {
    const settledIds = focusStageDecidedIds(state);
    return SWEPT_STAGES.flatMap((stage) => {
        const queue = state.queues[stage.id];
        if (!queue) {
            return [];
        }
        const count = stageArrivalCount(queue, stageEligibleItems(stage.id, items, context), settledIds);
        return count > 0 ? [{ stageId: stage.id, title: stage.title, count }] : [];
    });
}

/** Per-stage decision counts for the completion screen, in stage order. */
export function reviewStats(state: ReviewFlowState): Array<{ stageId: ReviewStageId; title: string; processedCount: number; wasSkipped: boolean }> {
    return REVIEW_STAGES.filter((stage) => stage.kind !== 'checklist').map((stage) => ({
        stageId: stage.id,
        title: stage.title,
        processedCount: state.queues[stage.id]?.decisions.length ?? 0,
        // Derived, not just stored: a wholesale skip the user later returned to and worked
        // through (free timeline jumps) is no longer "skipped" — decisions trump the skip mark.
        wasSkipped: state.skippedStageIds.includes(stage.id) && (state.queues[stage.id]?.decisions.length ?? 0) === 0,
    }));
}
