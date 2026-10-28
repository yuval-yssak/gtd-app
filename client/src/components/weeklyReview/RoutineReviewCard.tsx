import type { IDBPDatabase } from 'idb';
import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useAppData } from '../../contexts/AppDataProvider';
import { usePendingReassign } from '../../contexts/PendingReassignProvider';
import { clarifyToDone, FROM_GMAIL_READONLY_MESSAGE } from '../../db/itemMutations';
import { pauseRoutine } from '../../db/routineMutations';
import { Button, Card, Text } from '../../designSystem';
import type { MyDB, StoredItem, StoredRoutine } from '../../types/MyDB';
import { FutureDoneConfirmDialog, useFutureDoneConfirm } from '../FutureDoneConfirmDialog';
import { type ItemEditorActionsApi, ItemEditorBody } from '../itemEditor/ItemEditorBody';
import { RoutineEditorBody } from '../routineEditor/RoutineEditorBody';
import { PauseRoutineConfirmDialog } from '../routines/PauseRoutineConfirmDialog';
import { RoutineReviewBanner } from './RoutineReviewBanner';
import { routineEntryId, type StageDecisionUndo } from './reviewFlowState';
import { collapsedOccurrences, remainingOccurrencesLabel, reviewedOccurrence } from './routineReviewCardLogic';
import { StageActionBar, type StageTravel } from './StageActionBar';
import { StageCardScroller } from './StageCardScroller';
import { StageNavButtons } from './StageNavButtons';
import stageStyles from './stageLayout.module.css';
import type { useStageDecisionNavigation } from './useStageDecisionNavigation';
import { StageToast, useStageToast } from './useStageToast';

/** The slice of the stage's decision-navigation API a routine entry uses — the same editor handshake a one-off card runs. */
type RoutineEntryDecisionNav = Pick<
    ReturnType<typeof useStageDecisionNavigation>,
    'recordDecision' | 'liveNavProps' | 'blockedNavProps' | 'armExplicitSave' | 'markSaveCommitted' | 'closeAsDecisionOrSkip'
>;

interface RoutineReviewCardProps {
    routine: StoredRoutine;
    db: IDBPDatabase<MyDB>;
    nav: RoutineEntryDecisionNav;
    travel: StageTravel;
    /** The card is deciding its entry over this occurrence — keep it from re-joining the walk as an exception card. */
    onOccurrenceReviewed: (occurrenceId: string) => void;
}

/**
 * The calendar stage's collapsed routine entry. It IS a one-off calendar card — the same embedded
 * review editor, opened on the series' first undone occurrence (overdue included), where a time or
 * text edit makes that occurrence an exception exactly as it would from the calendar page. The
 * routine distinction is the banner (schedule + series tail) and the series-level actions in the
 * bar: Pause, and Edit series, which swaps the card body for the routine editor.
 *
 * Hosts MUST key this by routine id: the shown occurrence is pinned in state at mount.
 */
export function RoutineReviewCard({ routine, db, nav, travel, onOccurrenceReviewed }: RoutineReviewCardProps) {
    const { allItems, people, workContexts, refreshRoutines, refreshItems, syncAndRefresh } = useAppData();
    const { isPending } = usePendingReassign();
    const [isPauseConfirmOpen, setIsPauseConfirmOpen] = useState(false);
    const [isSeriesEditorOpen, setIsSeriesEditorOpen] = useState(false);
    const editButtonRef = useRef<HTMLButtonElement>(null);
    // useState (not useTransition): the pause flow carries an error message alongside the pending
    // flag — the richer-than-one-boolean exception to the useTransition default.
    const [isPausing, setIsPausing] = useState(false);
    // Same richer-than-a-boolean reason as the pause flow: completing surfaces its own error text.
    const [isCompleting, setIsCompleting] = useState(false);
    // Portal target for the editor's action row — state (not a ref) so ItemEditorBody re-renders
    // and portals the buttons in once the pinned bar element mounts.
    const [actionsBarEl, setActionsBarEl] = useState<HTMLElement | null>(null);
    const [isOccurrenceEditorLocked, setIsOccurrenceEditorLocked] = useState(false);
    // Pinned at mount: a time or text edit turns the shown occurrence into a modified exception,
    // which drops it from the collapse — without the pin the editor would jump to the next one.
    const [pinnedOccurrenceId] = useState(() => reviewedOccurrence(routine, allItems, undefined)?._id);
    const stageToast = useStageToast();
    const futureDone = useFutureDoneConfirm(allItems);
    // A mid-flight cross-account reassign would misroute the pause's item-trashing writes — same
    // guard the routine editor applies to edits.
    const reassignInFlight = isPending('routine', routine._id);
    const isWriting = isPausing || isCompleting;
    // Same rule as FocusStage / RevisitDecisionCard: a stage jump is a state change the
    // router-based unsaved-changes guard can never see, so lock travel while either editor holds
    // edits or a write is in flight.
    const isBusy = isWriting || isSeriesEditorOpen || isOccurrenceEditorLocked;
    const lockedTravel = isBusy ? { ...travel, prevDisabled: true, nextDisabled: true } : travel;
    // Every decision names this card's entry: pausing (or completing the last occurrence) makes
    // it ineligible, and the reconcile can drop it before the decision lands — deciding "current"
    // then would decide the NEXT card unseen.
    const entryId = routineEntryId(routine._id);
    const occurrence = reviewedOccurrence(routine, allItems, pinnedOccurrenceId);
    const seriesTail = remainingOccurrencesLabel(collapsedOccurrences(routine, allItems), occurrence);
    // The embedded editor carries the AccountPicker: while the occurrence's own reassign is in
    // flight it renders its inline notice and portals no actions — the bar keeps the escape hatch.
    const occurrenceReassignInFlight = occurrence !== undefined && isPending('item', occurrence._id);

    /**
     * Records this card's decision, retiring the shown occurrence first so its exception never
     * re-joins the walk. `undo` is `{}` only for the no-write "Looks good" (undone by a bare
     * requeue); every write here advances or rewrites the series, which no snapshot reverses.
     */
    function decideEntry(undo?: StageDecisionUndo) {
        retireShownOccurrence();
        nav.recordDecision(entryId, undo);
    }

    /**
     * Retired as the user acts, before any write: the write is what turns the occurrence into an
     * exception. A save that then fails only keeps a later remote exception for it out of this visit.
     */
    function retireShownOccurrence() {
        if (occurrence) {
            onOccurrenceReviewed(occurrence._id);
        }
    }

    /** Save & next: retire the occurrence, then hand off to the editor's save, whose post-save close decides the entry. */
    function saveAndDecide(api: ItemEditorActionsApi) {
        retireShownOccurrence();
        nav.armExplicitSave(undefined, api.triggerSave);
    }

    async function onPauseConfirmed() {
        setIsPauseConfirmOpen(false);
        setIsPausing(true);
        try {
            // The routine's OWNER, not the active session's account — the review walk spans every
            // visible account, and pausing under the wrong userId would strand the owner's items.
            await pauseRoutine(db, routine.userId, routine);
            await refreshRoutines();
            await refreshItems();
        } catch (err) {
            console.error('[weekly-review] pause routine failed:', err);
            stageToast.showError('Could not pause the routine — nothing changed.');
            return;
        } finally {
            setIsPausing(false);
        }
        // Only after the pause landed: irreversible from the review's point of view (items
        // trashed + GCal cap) — no undo.
        decideEntry();
        // Fire-and-forget: push the pause + pull the GCal-cap echo without holding up the walk.
        void syncAndRefresh();
    }

    /**
     * Complete the shown occurrence. `clarifyToDone` advances the series
     * (`maybeCreateNextRoutineItem`), so like every routine-generated disposal in the review this
     * arms NO undo — a snapshot restore would double-book the series.
     */
    async function onMarkOccurrenceDone(target: StoredItem) {
        setIsCompleting(true);
        try {
            await clarifyToDone(db, target, { onReadOnlyGCal: () => stageToast.showNotice(FROM_GMAIL_READONLY_MESSAGE) });
            await refreshItems();
        } catch (err) {
            console.error('[weekly-review] mark routine occurrence done failed:', err);
            stageToast.showError('Could not mark the occurrence done — nothing changed.');
            return;
        } finally {
            setIsCompleting(false);
        }
        decideEntry();
        void syncAndRefresh();
    }

    // Edit series is disabled while its editor is open, so closing would drop focus on <body>.
    // Commit the close synchronously so the button is back, then hand focus to it.
    function closeSeriesEditor() {
        flushSync(() => setIsSeriesEditorOpen(false));
        editButtonRef.current?.focus();
    }

    const onRoutineSaved = async () => {
        await refreshRoutines();
        await refreshItems();
    };

    // Pause / Edit series are disabled over unsaved occurrence edits: both replace or rewrite the
    // occurrence under the editor, silently dropping what the user typed.
    const renderActions = (api: ItemEditorActionsApi) => {
        const isSeriesActionBlocked = api.isSaving || api.isDirty || isWriting || reassignInFlight;
        return (
            <>
                <StageNavButtons {...nav.liveNavProps(api.isSaving || isWriting)} />
                {routine.active && (
                    <Button disabled={isSeriesActionBlocked} onClick={() => setIsPauseConfirmOpen(true)} data-testid="routineCardPause">
                        Pause
                    </Button>
                )}
                <Button ref={editButtonRef} disabled={isSeriesActionBlocked} onClick={() => setIsSeriesEditorOpen(true)} data-testid="routineCardEdit">
                    Edit series
                </Button>
                {occurrence && (
                    <Button
                        disabled={api.isSaving || isWriting || reassignInFlight}
                        onClick={() => futureDone.confirmDone(occurrence, (latest) => void onMarkOccurrenceDone(latest))}
                        data-testid="routineCardDone"
                    >
                        Done
                    </Button>
                )}
                {/* Dirty-aware primary, as on a one-off card: untouched → decide without a write
                    (a bare-requeue undo); edited → the body's save path commits, then its
                    post-save onClose decides with no undo — an occurrence edit is a routine
                    exception no snapshot reverses. */}
                <Button
                    variant="solid"
                    disabled={api.isDirty ? api.saveDisabled || isWriting : api.isSaving || isWriting}
                    onClick={api.isDirty ? () => saveAndDecide(api) : () => decideEntry({})}
                    data-testid="routineCardLooksGood"
                >
                    {api.isDirty || api.hasTextEdits ? 'Save & next' : 'Looks good'}
                </Button>
            </>
        );
    };

    return (
        <div className={stageStyles.stageRoot} data-testid="routineReviewCard">
            <StageCardScroller>
                <Card padding="none" className={stageStyles.editorCard}>
                    {isSeriesEditorOpen ? (
                        <RoutineEditorBody
                            key={routine._id}
                            db={db}
                            userId={routine.userId}
                            workContexts={workContexts}
                            people={people}
                            routine={routine}
                            onClose={closeSeriesEditor}
                            onSaved={onRoutineSaved}
                            // The user just pressed Edit series: put them in the form.
                            autoFocusTitle
                        />
                    ) : (
                        <>
                            <RoutineReviewBanner routine={routine} isException={false} routineId={routine._id} detail={seriesTail} />
                            {occurrence ? (
                                <ItemEditorBody
                                    key={occurrence._id}
                                    item={occurrence}
                                    db={db}
                                    people={people}
                                    workContexts={workContexts}
                                    onClose={() => nav.closeAsDecisionOrSkip(entryId)}
                                    // Routines too: a time/text edit records a `modified` exception on the routine row.
                                    onSaved={onRoutineSaved}
                                    onSaveCommitted={nav.markSaveCommitted}
                                    onDirtyLockChange={setIsOccurrenceEditorLocked}
                                    onFromGmailReadOnly={() => stageToast.showNotice(FROM_GMAIL_READONLY_MESSAGE)}
                                    presentation="review"
                                    // Text edits wait for Save & next too: an autosave would record the routine
                                    // exception mid-card, and the reconcile would swap the card out from under the user.
                                    isTextAutosaveAllowed={false}
                                    renderActions={renderActions}
                                    actionsContainer={actionsBarEl}
                                />
                            ) : (
                                <Text tone="secondary">This routine has no open occurrence on the calendar.</Text>
                            )}
                        </>
                    )}
                </Card>
            </StageCardScroller>
            <StageActionBar onBarMounted={setActionsBarEl} travel={lockedTravel}>
                {/* The occurrence editor portals the full action row; without it (series editor open,
                    nothing to show) the bar keeps the walk's own arrows. */}
                {(isSeriesEditorOpen || !occurrence) && <StageNavButtons {...nav.liveNavProps(isSeriesEditorOpen)} />}
                {!isSeriesEditorOpen && occurrenceReassignInFlight && <StageNavButtons {...nav.blockedNavProps('focusBlockedSkip')} />}
                {!isSeriesEditorOpen && !occurrence && (
                    <Button variant="solid" onClick={() => decideEntry({})} data-testid="routineCardLooksGood">
                        Looks good
                    </Button>
                )}
            </StageActionBar>
            <PauseRoutineConfirmDialog
                routine={isPauseConfirmOpen ? routine : null}
                onCancel={() => setIsPauseConfirmOpen(false)}
                onConfirm={() => void onPauseConfirmed()}
            />
            <FutureDoneConfirmDialog {...futureDone.dialogProps} />
            <StageToast {...stageToast.toastProps} />
        </div>
    );
}
