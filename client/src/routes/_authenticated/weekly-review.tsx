import { createFileRoute, useNavigate } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { Play } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { AppErrorBoundary } from '../../components/AppErrorBoundary';
import {
    deleteWeeklyReviewDraft,
    getLastCompletedTs,
    getWeeklyReviewDraft,
    saveWeeklyReviewDraft,
    setLastCompletedTs,
} from '../../components/weeklyReview/reviewDraftHelpers';
import {
    currentStage,
    isFlowComplete,
    isReviewStageId,
    jumpToStage,
    type ReviewFlowState,
    type ReviewFlowUpdater,
    type ReviewStageId,
    type StageArrival,
    stageIndexOf,
    startReviewFlow,
    unreviewedStageArrivals,
} from '../../components/weeklyReview/reviewFlowState';
import { WeeklyReviewWizard } from '../../components/weeklyReview/WeeklyReviewWizard';
import { useAppData } from '../../contexts/AppDataProvider';
import { seedDefaultReviewInboxesIfEmpty } from '../../db/reviewInboxMutations';
import { Button, Card, Spinner, Text } from '../../designSystem';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { getTodayIso } from '../../lib/dayClock';
import { hasAtLeastOne, type NonEmptyArray } from '../../lib/typeUtils';
import styles from './-weekly-review.module.css';

// Lazy: pulls canvas-confetti out of the main chunk — the celebration renders once per review.
const CompletionCelebration = lazy(() => import('../../components/weeklyReview/CompletionCelebration'));

export const Route = createFileRoute('/_authenticated/weekly-review')({
    // `?stage=<id>` mirrors the active review stage so a reload or shared link lands on it.
    validateSearch: (search: { stage?: unknown }): { stage?: ReviewStageId } => (isReviewStageId(search.stage) ? { stage: search.stage } : {}),
    component: WeeklyReviewPage,
});

type PagePhase =
    | { kind: 'loading' }
    | { kind: 'idle'; resumableFlow: ReviewFlowState | null }
    | { kind: 'active'; flow: ReviewFlowState }
    | { kind: 'sweep'; flow: ReviewFlowState; arrivals: NonEmptyArray<StageArrival> }
    | { kind: 'celebrating'; flow: ReviewFlowState };

function WeeklyReviewPage() {
    useDocumentTitle('Weekly Review');
    const { db } = Route.useRouteContext();
    const { stage: urlStageId } = Route.useSearch();
    const navigate = useNavigate();
    const { account, items, routines, refreshReviewInboxes, isInitialSyncing } = useAppData();
    const [phase, setPhase] = useState<PagePhase>({ kind: 'loading' });
    // The latest flow across every onFlowChange call, updated synchronously — functional updaters
    // resolve against THIS, not the render-captured phase. Two same-tick commits (the deferred
    // undo requeue, then the wizard's reconcile) therefore compose instead of the second
    // replacing the flow from a stale copy that never saw the first. Cleared whenever the page
    // leaves the active/celebrating phases.
    const latestFlowRef = useRef<ReviewFlowState | null>(null);

    // Resume an interrupted review from the device-local draft (best-effort resumability).
    useEffect(() => {
        if (!account) {
            return;
        }
        let cancelled = false;
        void getWeeklyReviewDraft(db, account.id).then((stored) => {
            if (!cancelled) {
                latestFlowRef.current = null;
                setPhase({ kind: 'idle', resumableFlow: stored ?? null });
            }
        });
        return () => {
            cancelled = true;
        };
    }, [db, account]);

    const activeStageId = phase.kind === 'active' ? (currentStage(phase.flow)?.id ?? null) : null;

    // URL → flow: browser back/forward or a hand-edited ?stage jumps the active review there.
    // The mirror direction (flow → URL) is written imperatively inside onFlowChange, so this pair
    // can't ping-pong: each side no-ops once the two agree.
    useEffect(() => {
        if (phase.kind !== 'active' || !urlStageId || urlStageId === activeStageId) {
            return;
        }
        onFlowChange((prev) => jumpToStage(prev, stageIndexOf(urlStageId)));
    });

    if (!account || phase.kind === 'loading') {
        return (
            <div className={styles.loadingWrapper}>
                <Spinner size={28} label="Loading the weekly review" />
            </div>
        );
    }

    function syncStageToUrl(stageId: ReviewStageId | undefined) {
        if (urlStageId !== stageId) {
            void navigate({ to: '/weekly-review', search: stageId ? { stage: stageId } : {}, replace: true });
        }
    }

    function onFlowChange(update: ReviewFlowState | ReviewFlowUpdater) {
        if (typeof update !== 'function') {
            commitFlow(update);
            return;
        }
        const base = latestFlowRef.current ?? (phase.kind === 'active' || phase.kind === 'sweep' || phase.kind === 'celebrating' ? phase.flow : null);
        if (!base) {
            // Functional updates only make sense against a live review; nothing to compose with.
            console.warn('[weekly-review] dropped a flow update — no active review to apply it to');
            return;
        }
        commitFlow(update(base));
    }

    function commitFlow(flow: ReviewFlowState) {
        if (!account) {
            return;
        }
        latestFlowRef.current = flow;
        if (isFlowComplete(flow)) {
            // Pre-celebration sweep: reviewing generates new items — a stage already worked
            // through may have gained arrivals the user never saw. Offer a revisit before
            // declaring the review done; the draft stays alive until the actual celebration.
            // Known staleness window: `items` is the render-closure snapshot, so an arrival
            // created by the very decision that completes the flow may not be visible yet —
            // the failure mode is a skipped sweep (next review catches it), never corruption.
            const arrivals = unreviewedStageArrivals(flow, items, {
                // Shared day clock (fresh here — event-time, not render-cached) so every tickler
                // boundary in the app reads one day source.
                todayIso: getTodayIso(),
                routines,
            });
            if (hasAtLeastOne(arrivals)) {
                setPhase({ kind: 'sweep', flow, arrivals });
                syncStageToUrl(undefined);
                void saveWeeklyReviewDraft(db, account.id, flow).catch((err) => console.warn('[weekly-review] failed to persist progress', err));
                return;
            }
            celebrate(flow);
            return;
        }
        setPhase({ kind: 'active', flow });
        syncStageToUrl(currentStage(flow)?.id);
        // Fire-and-forget persistence — the draft is a convenience, never the source of truth.
        void saveWeeklyReviewDraft(db, account.id, flow).catch((err) => console.warn('[weekly-review] failed to persist progress', err));
    }

    function celebrate(flow: ReviewFlowState) {
        if (!account) {
            return;
        }
        setPhase({ kind: 'celebrating', flow });
        setLastCompletedTs(account.id, dayjs().toISOString());
        void deleteWeeklyReviewDraft(db, account.id);
        syncStageToUrl(undefined);
    }

    /** Resume/start honour a deep-linked ?stage by jumping the flow there before activating. */
    function activateFlow(flow: ReviewFlowState) {
        onFlowChange(urlStageId ? jumpToStage(flow, stageIndexOf(urlStageId)) : flow);
    }

    async function onStart() {
        if (!account) {
            return;
        }
        // First review on this account seeds the starter buckets (Email, Physical In Tray, …).
        // Never while the first sync is still in flight: seeding into that empty window would
        // stamp newer updatedTs over the server's rows for the same deterministic ids, and LWW
        // would revert renames/deletions made on another device.
        if (!isInitialSyncing) {
            await seedDefaultReviewInboxesIfEmpty(db, account.id);
            await refreshReviewInboxes();
        }
        activateFlow(startReviewFlow(dayjs().toISOString()));
    }

    async function onStartOver() {
        if (account) {
            await deleteWeeklyReviewDraft(db, account.id);
        }
        await onStart();
    }

    const finishCelebration = () => {
        latestFlowRef.current = null;
        // Deliberately NO setPhase back to idle: the navigation unmounts this route, and
        // resetting first would flash the intro screen for a frame. A later visit remounts and
        // re-reads the (already deleted) draft fresh.
        void navigate({ to: '/inbox' });
    };

    if (phase.kind === 'celebrating') {
        return (
            // Boundary outside the Suspense boundary (per client conventions): the lazy chunk can
            // fail to load (e.g. the skipWaiting stale-chunk window) — the review is already
            // complete and persisted by this point, so the fallback just finishes.
            <AppErrorBoundary
                mode="inline"
                title="Couldn't load the celebration"
                fallbackAction={() => (
                    <Button tone="neutral" size="sm" onClick={finishCelebration}>
                        Done
                    </Button>
                )}
            >
                <Suspense fallback={null}>
                    <CompletionCelebration flow={phase.flow} onFinish={finishCelebration} />
                </Suspense>
            </AppErrorBoundary>
        );
    }

    if (phase.kind === 'sweep') {
        return (
            <SweepScreen
                arrivals={phase.arrivals}
                // Jump into a stage with arrivals; entering it live-appends them to its queue.
                // Walking forward from there re-runs the completion check, so the sweep repeats
                // until clean (or the user finishes anyway).
                onReviewStage={(stageId) => onFlowChange((prev) => jumpToStage(prev, stageIndexOf(stageId)))}
                onFinishAnyway={() => celebrate(phase.flow)}
            />
        );
    }

    if (phase.kind === 'active') {
        return <WeeklyReviewWizard db={db} flow={phase.flow} onFlowChange={onFlowChange} />;
    }

    return (
        <IntroScreen
            resumableFlow={phase.resumableFlow}
            lastCompletedTs={getLastCompletedTs(account.id)}
            onStart={() => void onStart()}
            // Through activateFlow → onFlowChange (not a bare setPhase) so a deep-linked ?stage is
            // honoured and a somehow-complete flow routes into the celebration.
            onResume={activateFlow}
            onStartOver={() => void onStartOver()}
        />
    );
}

interface SweepScreenProps {
    arrivals: NonEmptyArray<StageArrival>;
    onReviewStage: (stageId: ReviewStageId) => void;
    onFinishAnyway: () => void;
}

/** Pre-celebration catch: stages already reviewed gained new items — offer a revisit before finishing. */
function SweepScreen({ arrivals, onReviewStage, onFinishAnyway }: SweepScreenProps) {
    return (
        <div className={styles.introWrapper}>
            <Card padding="none" className={styles.introCard} data-testid="sweepScreen">
                <Text as="h1" variant="headline" weight="bold">
                    Almost done…
                </Text>
                <Text tone="secondary">Reviewing generated new items in lists you already went through:</Text>
                <div>
                    {arrivals.map((arrival) => (
                        <Button key={arrival.stageId} tone="neutral" size="sm" onClick={() => onReviewStage(arrival.stageId)} data-testid="sweepStageRow">
                            {arrival.title} — {arrival.count} new {arrival.count === 1 ? 'item' : 'items'}
                        </Button>
                    ))}
                </div>
                <div className={styles.introActions}>
                    <Button variant="solid" size="lg" startIcon={<Play />} onClick={() => onReviewStage(arrivals[0].stageId)} data-testid="sweepReviewButton">
                        Review them
                    </Button>
                    <Button tone="neutral" onClick={onFinishAnyway} data-testid="sweepFinishButton">
                        Finish anyway
                    </Button>
                </div>
            </Card>
        </div>
    );
}

interface IntroScreenProps {
    resumableFlow: ReviewFlowState | null;
    lastCompletedTs: string | null;
    onStart: () => void;
    onResume: (flow: ReviewFlowState) => void;
    onStartOver: () => void;
}

function IntroScreen({ resumableFlow, lastCompletedTs, onStart, onResume, onStartOver }: IntroScreenProps) {
    return (
        <div className={styles.introWrapper}>
            <Card padding="none" className={styles.introCard}>
                <Text as="h1" variant="headline" weight="bold">
                    Weekly Review
                </Text>
                <Text tone="secondary">
                    A guided pass through every inbox and every list — one item at a time — so nothing is left rattling around in your head.
                </Text>
                {lastCompletedTs && (
                    <Text variant="caption" tone="secondary" data-testid="lastCompletedLabel">
                        Last completed {dayjs(lastCompletedTs).format('dddd, MMM D')}
                    </Text>
                )}
                {resumableFlow ? (
                    <div className={styles.introActions}>
                        <Button variant="solid" size="lg" startIcon={<Play />} onClick={() => onResume(resumableFlow)} data-testid="resumeReviewButton">
                            Resume review
                        </Button>
                        <Button tone="neutral" onClick={onStartOver} data-testid="startOverButton">
                            Start over
                        </Button>
                    </div>
                ) : (
                    <Button variant="solid" size="lg" startIcon={<Play />} onClick={onStart} data-testid="startReviewButton">
                        Start weekly review
                    </Button>
                )}
            </Card>
        </div>
    );
}
