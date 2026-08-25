import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import Step from '@mui/material/Step';
import StepButton from '@mui/material/StepButton';
import Stepper from '@mui/material/Stepper';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import classNames from 'classnames';
import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppData } from '../../contexts/AppDataProvider';
import { personNameMap } from '../../lib/waitingForGroups';
import type { MyDB } from '../../types/MyDB';
import { ClarifyStage } from './ClarifyStage';
import { FocusStage } from './FocusStage';
import { InboxChecklistStage } from './InboxChecklistStage';
import {
    advanceStage,
    currentStage,
    isChecklistComplete,
    jumpToStage,
    REVIEW_STAGES,
    type ReviewFlowState,
    type ReviewFlowUpdater,
    type ReviewStageDefinition,
    type ReviewStageId,
    reconcileQueue,
    refreshQueueOnEntry,
    type StageQueue,
    skipStage,
    stageEligibleItems,
    toggleInboxTick,
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
    const { account, items, allPeople, allReviewInboxes } = useAppData();
    // Item advances and stage changes unmount the focused button — restore keyboard focus onto
    // its equivalent in the new view instead of letting it fall to <body>.
    const wizardRootRef = useRef<HTMLDivElement | null>(null);
    useTransitionFocusRestore(wizardRootRef);
    const stage = currentStage(flow);
    const today = dayjs().format('YYYY-MM-DD');
    // Unfiltered allPeople, like /waiting-for: a queued item can wait on a hidden account's person.
    const personNameById = useMemo(() => personNameMap(allPeople), [allPeople]);
    const queue = stage ? flow.queues[stage.id] : undefined;
    // Header collapse (screen real estate): the review STARTS with the full header (the checklist
    // stage); every other view — items, stage-end cards, empty stages — defaults to the slim
    // strip. The toggle is STICKY: expanding keeps the full header across items and stages until
    // the user collapses it again (and vice versa).
    const [isHeaderExpandedByUser, setIsHeaderExpandedByUser] = useState(false);
    const hasStageActivity = queue !== undefined && (queue.decisions.length > 0 || queue.cursor > 0);
    const isHeaderCollapsed = stage !== null && stage.kind !== 'checklist' && !isHeaderExpandedByUser;
    const inboxIds = allReviewInboxes.filter((inbox) => inbox.userId === account?.id).map((inbox) => inbox._id);
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
        const eligibleIds = stageEligibleItems(stage.id, items, { todayIso: today, personNameById }).map((item) => item._id);
        const refresh = (queue: StageQueue | undefined) => (isEntry || !queue ? refreshQueueOnEntry(queue, eligibleIds) : reconcileQueue(queue, eligibleIds));
        if (refresh(flow.queues[stage.id]) !== flow.queues[stage.id]) {
            // Recompute against the LATEST flow inside the updater: another commit (e.g. the
            // deferred undo requeue) may have landed since this render, and both helpers are
            // idempotent, so composing here can never clobber it.
            onFlowChange((prev) => withStageQueue(prev, stage.id, refresh(prev.queues[stage.id])));
        }
    }, [stage, items, today, personNameById, flow, onFlowChange]);

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
        <Box className={styles.wizardRoot} ref={wizardRootRef}>
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
        </Box>
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
        <Box className={styles.stepperScroller}>
            <Stepper nonLinear activeStep={flow.stageIndex} alternativeLabel className={styles.stepper} data-testid="reviewStepper">
                {REVIEW_STAGES.map((stage, index) => (
                    <Step key={stage.id} completed={isStageDone(flow, stage, inboxIds)}>
                        <StepButton onClick={() => onJump(index)} data-testid="reviewStepperStep">
                            {stage.title}
                        </StepButton>
                    </Step>
                ))}
            </Stepper>
        </Box>
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

/** Item progress within the stage — label ("2 of 12") plus the matching percentage for a bar. */
function stageItemProgress(queue: StageQueue | undefined): { label: string; value: number } | null {
    if (!queue) {
        return null;
    }
    const total = queue.decisions.length + queue.pending.length;
    if (total === 0) {
        return null;
    }
    return { label: `${queue.decisions.length} of ${total}`, value: (queue.decisions.length / total) * 100 };
}

/** Review-wide progress percentage — the full header's bar (the strip's bar is stage-scoped). */
const reviewProgressValue = (flow: ReviewFlowState) => (flow.stageIndex / REVIEW_STAGES.length) * 100;

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
        <ButtonBase className={styles.headerStrip} onClick={onExpand} aria-expanded={false} aria-label="Expand review header" data-testid="reviewHeaderStrip">
            <Typography variant="subtitle1" className={classNames(styles.stageTitle, styles.stripLabel)} data-testid="reviewStageTitle">
                {stage.title}
            </Typography>
            {itemProgress && (
                <>
                    <Typography variant="caption" color="text.secondary" className={styles.stripLabel} data-testid="reviewStageCounter">
                        {itemProgress.label}
                    </Typography>
                    <LinearProgress variant="determinate" value={itemProgress.value} className={styles.stripProgress} />
                </>
            )}
            <Box role="img" aria-label={`Stage ${stageNumber} of ${stageDots.length}`} className={styles.stripDots} data-testid="stripStageDots">
                {stageDots.map((dot) => (
                    <span
                        key={dot.stageId}
                        className={classNames(styles.stripDot, { [styles.stripDotDone]: dot.isDone, [styles.stripDotCurrent]: dot.isCurrent })}
                    />
                ))}
            </Box>
            <ExpandMoreIcon fontSize="small" color="disabled" />
        </ButtonBase>
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

    return (
        <Box className={styles.header}>
            <Box className={styles.headerRow}>
                <Box>
                    <Typography variant="overline" color="text.secondary" data-testid="reviewStageCounter">
                        Stage {stageNumber} of {REVIEW_STAGES.length}
                        {itemProgress ? ` · ${itemProgress}` : ''}
                    </Typography>
                    <Box className={styles.titleRow}>
                        <Typography variant="h5" className={styles.stageTitle} data-testid="reviewStageTitle">
                            {stage.title}
                        </Typography>
                        {hasStageActivity && (
                            <Tooltip title={stage.guidance}>
                                {/* A real button, not a bare SVG: MUI's Tooltip shows on focus and
                                    touch only for an interactive child — an icon alone would make
                                    the guidance hover-only (see RoutineIndicator). */}
                                <IconButton size="small" aria-label="Stage guidance" data-testid="stageGuidanceInfo">
                                    <InfoOutlinedIcon fontSize="small" />
                                </IconButton>
                            </Tooltip>
                        )}
                    </Box>
                    {!hasStageActivity && (
                        <Typography variant="body2" color="text.secondary">
                            {stage.guidance}
                        </Typography>
                    )}
                </Box>
                <Box className={styles.headerControls}>
                    <Button color="inherit" size="small" onClick={onSkipStage} data-testid="skipStageButton">
                        Skip stage →
                    </Button>
                    {canCollapse && (
                        <IconButton size="small" onClick={onCollapse} aria-label="Collapse review header" data-testid="collapseHeaderButton">
                            <ExpandLessIcon fontSize="small" />
                        </IconButton>
                    )}
                </Box>
            </Box>
            <LinearProgress variant="determinate" value={reviewProgressValue(flow)} className={styles.progressBar} />
        </Box>
    );
}
