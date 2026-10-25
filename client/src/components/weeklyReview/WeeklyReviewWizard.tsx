import { clsx } from 'clsx';
import type { IDBPDatabase } from 'idb';
import { ChevronDown, ChevronUp, Info } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAppData } from '../../contexts/AppDataProvider';
import { Button, IconButton, ProgressBar, StepIndicator, Switch, Text, Tooltip } from '../../designSystem';
import { useOnline } from '../../hooks/useOnline';
import { useTodayIso } from '../../hooks/useTodayIso';
import { setShowBriefs, useShowBriefs } from '../../lib/briefPreference';
import type { MyDB } from '../../types/MyDB';
import { ClarifyStage } from './ClarifyStage';
import { FocusStage } from './FocusStage';
import { InboxChecklistStage } from './InboxChecklistStage';
import { reviewSweepKey, runReviewBriefSweepOnce, sweepPinnedToOwner } from './reviewBriefSweep';
import {
    advanceStage,
    currentStage,
    isChecklistComplete,
    jumpToStage,
    normalizeCalendarQueue,
    REVIEW_STAGES,
    type ReviewFlowState,
    type ReviewFlowUpdater,
    type ReviewStageDefinition,
    type ReviewStageId,
    reconcileQueue,
    refreshQueueOnEntry,
    type StageQueue,
    skipStage,
    stageEligibleEntryIds,
    toggleInboxTick,
    walkedEntryCount,
    withStageQueue,
} from './reviewFlowState';
import type { StageTravel } from './StageActionBar';
import { useTransitionFocusRestore } from './useTransitionFocusRestore';
import styles from './WeeklyReviewWizard.module.css';

interface WeeklyReviewWizardProps {
    db: IDBPDatabase<MyDB>;
    flow: ReviewFlowState;
    /** Always called with a functional updater here — see ReviewFlowUpdater for why. */
    onFlowChange: (update: ReviewFlowUpdater) => void;
}

/** Guided multi-step weekly review. One stage at a time, one item at a time inside each stage. */
export function WeeklyReviewWizard({ db, flow, onFlowChange }: WeeklyReviewWizardProps) {
    const { account, items, routines, allReviewInboxes, loggedInAccounts, withOwnerSession } = useAppData();
    const accountId = account?.id;
    const isOnline = useOnline();
    // Item advances and stage changes unmount the focused button — restore keyboard focus onto
    // its equivalent in the new view instead of letting it fall to <body>.
    const wizardRootRef = useRef<HTMLDivElement | null>(null);
    useTransitionFocusRestore(wizardRootRef);
    const stage = currentStage(flow);
    // Shared day clock (already an effect dep below): a review left open across midnight
    // re-reconciles stage eligibility against the new day instead of a stale render-time date.
    const today = useTodayIso();
    const queue = stage ? flow.queues[stage.id] : undefined;
    // Header collapse (screen real estate): the review STARTS with the full header (the checklist
    // stage); every other view — items, stage-end cards, empty stages — defaults to the slim
    // strip. The toggle is STICKY: expanding keeps the full header across items and stages until
    // the user collapses it again (and vice versa).
    const [isHeaderExpandedByUser, setIsHeaderExpandedByUser] = useState(false);
    const hasStageActivity = queue !== undefined && walkedEntryCount(queue) > 0;
    const isHeaderCollapsed = stage !== null && stage.kind !== 'checklist' && !isHeaderExpandedByUser;
    const inboxIds = allReviewInboxes.filter((inbox) => inbox.userId === accountId).map((inbox) => inbox._id);
    // Review-wide position for the strip's mini dots — precomputed so the strip itself never
    // touches review-wide state (only display data crosses its props).
    const stageDots = REVIEW_STAGES.map((stageDefinition, index) => ({
        stageId: stageDefinition.id,
        isDone: isStageDone(flow, stageDefinition, inboxIds),
        isCurrent: index === flow.stageIndex,
    }));

    // On stage (re-)entry, rebuild the queue: undecided leftovers keep their place and anything
    // newly eligible is appended — so revisiting a stage via the timeline offers exactly the
    // not-yet-decided items. WITHIN a stage the reconcile drops ids that stopped qualifying AND
    // live-appends new arrivals to the end of the walk (per design: the "n of m" total grows,
    // only entry resets the cursor). Both helpers return the same reference when nothing changed,
    // so this effect settles.
    const enteredStageIdRef = useRef<ReviewStageId | null>(null);
    useEffect(() => {
        if (!stage || stage.kind === 'checklist') {
            enteredStageIdRef.current = stage?.id ?? null;
            return;
        }
        const isEntry = enteredStageIdRef.current !== stage.id;
        enteredStageIdRef.current = stage.id;
        const eligibleIds = stageEligibleEntryIds(stage.id, items, { todayIso: today, routines });
        // Calendar queues are re-mapped onto today's collapse BEFORE merging: a resumed draft (or
        // a routine row that only now healed to active) can hold raw occurrence ids — left alone,
        // the merge would keep offering every occurrence individually alongside its routine card.
        const normalize = (stageQueue: StageQueue | undefined) =>
            stageQueue && stage.id === 'calendar' ? normalizeCalendarQueue(stageQueue, items, routines) : stageQueue;
        const refresh = (rawQueue: StageQueue | undefined) => {
            const normalizedQueue = normalize(rawQueue);
            return isEntry || !normalizedQueue ? refreshQueueOnEntry(normalizedQueue, eligibleIds) : reconcileQueue(normalizedQueue, eligibleIds);
        };
        if (refresh(flow.queues[stage.id]) !== flow.queues[stage.id]) {
            // Recompute against the LATEST flow inside the updater: another commit (e.g. the
            // deferred undo requeue) may have landed since this render, and both helpers are
            // idempotent, so composing here can never clobber it.
            onFlowChange((prev) => withStageQueue(prev, stage.id, refresh(prev.queues[stage.id])));
        }
    }, [stage, items, routines, today, flow, onFlowChange]);

    // Kick off the server-side brief sweep for this review run: items whose title + notes checksum
    // moved since their brief get a fresh one. Fire-and-forget — the briefs arrive later as
    // ordinary `itemBrief` sync ops, so nothing here waits, blocks a render, or is shown to the
    // user (the server's "you already swept" cooldown is a normal answer). The module-level guard
    // in `reviewBriefSweep.ts`, keyed on account + `flow.startedTs`, is what makes it exactly one
    // request per review run across StrictMode double-effects and wizard remounts. `isOnline` is a
    // dep, not just a guard: a review opened offline sweeps the moment connectivity returns,
    // without waiting for the user to reopen it.
    const reviewStartedTs = flow.startedTs;
    const isMultiAccountDevice = loggedInAccounts.length > 1;
    useEffect(() => {
        if (!accountId) {
            return;
        }
        void runReviewBriefSweepOnce(reviewSweepKey(accountId, reviewStartedTs), {
            isOnline: () => isOnline,
            requestSweep: () => sweepPinnedToOwner({ accountId, isMultiAccountDevice, withOwnerSession }),
            onError: (error) => console.warn('[weekly-review] brief sweep failed', error),
            onOutcome: (outcome) => {
                if (outcome === 'failed') {
                    console.warn('[weekly-review] brief sweep did not run — the 15-minute server sweep is the backstop');
                }
            },
        });
    }, [accountId, isMultiAccountDevice, isOnline, reviewStartedTs, withOwnerSession]);

    if (!stage) {
        return null;
    }

    // Functional all the way down: the queue transform runs against the latest flow's queue, so
    // same-tick commits from different owners (stage decision, deferred undo requeue, reconcile)
    // compose instead of overwriting each other. Load-bearing detail: `stage.id` is captured at
    // render, so a stale closure firing after a travel jump (e.g. a decision whose refreshItems
    // was still in flight when ⏩ unmounted the stage) still lands on the OLD stage's queue —
    // never on whichever stage is current by then.
    const onQueueChange = (updateQueue: (queue: StageQueue) => StageQueue) =>
        onFlowChange((prev) => {
            const existing = prev.queues[stage.id];
            return existing ? withStageQueue(prev, stage.id, updateQueue(existing)) : prev;
        });
    const onStageFinished = () => onFlowChange(advanceStage);
    // Stage-level travel arrows on the pinned bar's edges: plain jumps (like stepper clicks — no
    // skip marks), resolved against the latest flow so a rapid double-click moves two stages, not
    // one twice. Forward is disabled on the last stage: finishing the review (celebration, draft
    // deletion) stays behind an explicit Continue.
    const travel: StageTravel = {
        onPrevStage: () => onFlowChange((prev) => jumpToStage(prev, prev.stageIndex - 1)),
        onNextStage: () => onFlowChange((prev) => jumpToStage(prev, prev.stageIndex + 1)),
        prevDisabled: flow.stageIndex === 0,
        nextDisabled: flow.stageIndex === REVIEW_STAGES.length - 1,
    };

    return (
        <div className={styles.wizardRoot} ref={wizardRootRef}>
            {isHeaderCollapsed ? (
                <CollapsedHeaderStrip stage={stage} queue={queue} stageDots={stageDots} onExpand={() => setIsHeaderExpandedByUser(true)} />
            ) : (
                <>
                    <ReviewStepper flow={flow} inboxIds={inboxIds} onJump={(index) => onFlowChange((prev) => jumpToStage(prev, index))} />
                    <WizardHeader
                        flow={flow}
                        stage={stage}
                        queue={queue}
                        onSkipStage={() => onFlowChange(skipStage)}
                        hasStageActivity={hasStageActivity}
                        canCollapse={stage.kind !== 'checklist'}
                        onCollapse={() => setIsHeaderExpandedByUser(false)}
                    />
                </>
            )}
            {stage.kind === 'checklist' && (
                <InboxChecklistStage
                    db={db}
                    tickedInboxIds={flow.tickedInboxIds}
                    onToggleTick={(inboxId) => onFlowChange((prev) => toggleInboxTick(prev, inboxId))}
                    onStageFinished={onStageFinished}
                    travel={travel}
                />
            )}
            {/* key={stage.id}: two consecutive stages of the same kind (clarify/finalSweep, the
                focus run) would otherwise keep one component instance, carrying its revisit
                backOffset from one stage's history into the next. */}
            {stage.kind === 'clarify' && queue && (
                <ClarifyStage key={stage.id} queue={queue} db={db} onQueueChange={onQueueChange} onStageFinished={onStageFinished} travel={travel} />
            )}
            {stage.kind === 'focus' && queue && (
                <FocusStage
                    key={stage.id}
                    stage={stage}
                    queue={queue}
                    db={db}
                    onQueueChange={onQueueChange}
                    onStageFinished={onStageFinished}
                    travel={travel}
                />
            )}
        </div>
    );
}

interface ReviewStepperProps {
    flow: ReviewFlowState;
    /** The active account's user-defined inbox ids — drives the checklist stage's completed tick. */
    inboxIds: string[];
    onJump: (stageIndex: number) => void;
}

/** Always-visible timeline: every stage clickable, any time, in either direction (free jumps). */
function ReviewStepper({ flow, inboxIds, onJump }: ReviewStepperProps) {
    return (
        <StepIndicator
            aria-label="Review stages"
            labelPlacement="below"
            activeIndex={flow.stageIndex}
            steps={REVIEW_STAGES.map((stage) => ({ key: stage.id, label: stage.title, isComplete: isStageDone(flow, stage, inboxIds) }))}
            onStepSelected={onJump}
            stepTestId="reviewStepperStep"
            className={styles.stepper}
            data-testid="reviewStepper"
        />
    );
}

/** "Done" for the timeline's checkmarks: checklist fully ticked, or every queued item decided. */
function isStageDone(flow: ReviewFlowState, stage: ReviewStageDefinition, inboxIds: string[]): boolean {
    if (stage.kind === 'checklist') {
        return isChecklistComplete(flow.tickedInboxIds, inboxIds);
    }
    const queue = flow.queues[stage.id];
    return queue !== undefined && queue.pending.length === 0;
}

/**
 * Item progress within the stage — label ("2 of 12") plus the matching percentage for a bar.
 * Counts POSITION in the walk (decided + skipped-past), not decisions alone: ▶-skipping must
 * move the counter too, or an all-skips walk would read "0 of 12" right up to the end card.
 */
function stageItemProgress(queue: StageQueue | undefined): { label: string; value: number } | null {
    if (!queue) {
        return null;
    }
    const total = queue.decisions.length + queue.pending.length;
    if (total === 0) {
        return null;
    }
    const walked = walkedEntryCount(queue);
    // Whole percent: the bar announces this as aria-valuenow, and "66.666…" reads as noise.
    return { label: `${walked} of ${total}`, value: Math.round((walked / total) * 100) };
}

/** Review-wide progress percentage — the full header's bar (the strip's bar is stage-scoped). */
const reviewProgressValue = (flow: ReviewFlowState) => Math.round((flow.stageIndex / REVIEW_STAGES.length) * 100);

interface StripStageDot {
    stageId: ReviewStageId;
    isDone: boolean;
    isCurrent: boolean;
}

interface CollapsedHeaderStripProps {
    stage: ReviewStageDefinition;
    queue: StageQueue | undefined;
    /** Review-wide position, precomputed by the wizard — one dot per stage. */
    stageDots: StripStageDot[];
    onExpand: () => void;
}

/**
 * The slim one-line header shown once the user is working a stage. The counter and the bar next
 * to it are STAGE-scoped and always agree — so neither reads as a legend for anything
 * review-wide. Review-wide position appears only as the mini stage DOTS at the right end, the
 * same visual language as the expanded timeline. Renders instead of — never alongside — the full
 * header, so the shared testids stay unique.
 */
function CollapsedHeaderStrip({ stage, queue, stageDots, onExpand }: CollapsedHeaderStripProps) {
    const itemProgress = stageItemProgress(queue);
    const stageNumber = stageDots.findIndex((dot) => dot.isCurrent) + 1;
    return (
        <button
            type="button"
            className={styles.headerStrip}
            onClick={onExpand}
            aria-expanded={false}
            aria-label="Expand review header"
            data-testid="reviewHeaderStrip"
        >
            <Text as="span" variant="subtitle" className={clsx(styles.stageTitle, styles.stripLabel)} data-testid="reviewStageTitle">
                {stage.title}
            </Text>
            {itemProgress && (
                <>
                    <Text variant="caption" tone="secondary" className={styles.stripLabel} data-testid="reviewStageCounter">
                        {itemProgress.label}
                    </Text>
                    <ProgressBar as="span" value={itemProgress.value} aria-label="Stage progress" className={styles.stripProgress} />
                </>
            )}
            <span role="img" aria-label={`Stage ${stageNumber} of ${stageDots.length}`} className={styles.stripDots} data-testid="stripStageDots">
                {stageDots.map((dot) => (
                    <span key={dot.stageId} className={styles.stripDot} data-done={dot.isDone || undefined} data-current={dot.isCurrent || undefined} />
                ))}
            </span>
            <ChevronDown size={18} className={styles.stripChevron} />
        </button>
    );
}

interface WizardHeaderProps {
    flow: ReviewFlowState;
    stage: ReviewStageDefinition;
    queue: StageQueue | undefined;
    onSkipStage: () => void;
    /** Whether the user has acted in this stage — folds the guidance line into the ⓘ tooltip. */
    hasStageActivity: boolean;
    /** Every stage but the review-start checklist can collapse to the strip. */
    canCollapse: boolean;
    onCollapse: () => void;
}

function WizardHeader({ flow, stage, queue, onSkipStage, hasStageActivity, canCollapse, onCollapse }: WizardHeaderProps) {
    const stageNumber = flow.stageIndex + 1;
    const itemProgress = stageItemProgress(queue)?.label ?? null;
    const isShowBriefsOn = useShowBriefs();

    return (
        <div className={styles.header}>
            <div className={styles.headerRow}>
                <div>
                    <Text variant="overline" tone="secondary" data-testid="reviewStageCounter">
                        Stage {stageNumber} of {REVIEW_STAGES.length}
                        {itemProgress ? ` · ${itemProgress}` : ''}
                    </Text>
                    <div className={styles.titleRow}>
                        <Text as="h1" variant="title" className={styles.stageTitle} data-testid="reviewStageTitle">
                            {stage.title}
                        </Text>
                        {hasStageActivity && (
                            <Tooltip title={stage.guidance}>
                                {/* A real button, not a bare SVG: the tooltip opens on focus only for
                                    an interactive trigger — an icon alone would make the guidance
                                    hover-only (see RoutineIndicator). */}
                                <IconButton size="sm" aria-label="Stage guidance" data-testid="stageGuidanceInfo">
                                    <Info />
                                </IconButton>
                            </Tooltip>
                        )}
                    </div>
                    {!hasStageActivity && (
                        <Text variant="bodySm" tone="secondary">
                            {stage.guidance}
                        </Text>
                    )}
                </div>
                <div className={styles.headerControls}>
                    {/* Device-local: whether item cards lead with their brief (notes folded) or
                        show the notes preview. Mirrors the Settings → Weekly review switch. */}
                    <Switch label="Show briefs" checked={isShowBriefsOn} onCheckedChange={setShowBriefs} data-testid="showBriefsToggle" />
                    <Button tone="neutral" size="sm" onClick={onSkipStage} data-testid="skipStageButton">
                        Skip stage →
                    </Button>
                    {canCollapse && (
                        <IconButton size="sm" onClick={onCollapse} aria-label="Collapse review header" data-testid="collapseHeaderButton">
                            <ChevronUp />
                        </IconButton>
                    )}
                </div>
            </div>
            <ProgressBar value={reviewProgressValue(flow)} aria-label="Review progress" />
        </div>
    );
}
