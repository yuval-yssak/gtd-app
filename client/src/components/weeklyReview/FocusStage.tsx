import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Snackbar from '@mui/material/Snackbar';
import Typography from '@mui/material/Typography';
import type { IDBPDatabase } from 'idb';
import { useState } from 'react';
import { useAppData } from '../../contexts/AppDataProvider';
import { usePendingReassign } from '../../contexts/PendingReassignProvider';
import { clarifyToDone, clarifyToTrash, FROM_GMAIL_READONLY_MESSAGE, releaseFromTickler } from '../../db/itemMutations';
import type { MyDB } from '../../types/MyDB';
import { type ItemEditorActionsApi, ItemEditorBody } from '../itemEditor/ItemEditorBody';
import { RevisitDecisionCard } from './RevisitDecisionCard';
import { RoutineReviewBanner } from './RoutineReviewBanner';
import { RoutineReviewCard } from './RoutineReviewCard';
import {
    currentQueueItemId,
    isModifiedExceptionItem,
    type ReviewStageDefinition,
    routineIdOfEntry,
    type StageDecisionUndo,
    type StageQueue,
    stageEndTitle,
} from './reviewFlowState';
import { StageActionBar, type StageTravel } from './StageActionBar';
import { StageEmptyCard } from './StageEmptyCard';
import { StageNavButtons } from './StageNavButtons';
import styles from './stageLayout.module.css';
import { useStageDecisionNavigation } from './useStageDecisionNavigation';

interface FocusStageProps {
    stage: ReviewStageDefinition;
    queue: StageQueue;
    db: IDBPDatabase<MyDB>;
    /** Functional: the transform is applied to the LATEST queue, composing with same-tick commits. */
    onQueueChange: (updateQueue: (queue: StageQueue) => StageQueue) => void;
    onStageFinished: () => void;
    travel: StageTravel;
}

/**
 * Solo-item review stage (Marie Kondo style): one item at a time, with the FULL item editor
 * embedded in the card — status chips, contexts, dates, notes — so any adjustment happens in
 * place. The primary action reads the editor's dirty state: an untouched item advances with
 * "Looks good" (no write); once anything changed it becomes "Save & next". The ▶ arrow steps past
 * the item (the walk is linear and ENDS at the stage-end card — no cycling); the ◀ arrow steps
 * back to skipped items and then revisits past decisions (with one-click undo).
 */
export function FocusStage({ stage, queue, db, onQueueChange, onStageFinished, travel }: FocusStageProps) {
    // `routines` (visible accounts), not `allRoutines`: the wizard QUEUES entries from the visible
    // set, so the stage must resolve them from the same set — an allRoutines lookup could render a
    // card for an entry the reconcile is about to drop.
    const { allItems, routines, people, workContexts, refreshItems } = useAppData();
    const { isPending } = usePendingReassign();
    const [toast, setToast] = useState('');
    // Portal target for the editor's action row — state (not a ref) so ItemEditorBody re-renders
    // and portals the buttons in once the pinned bar element mounts.
    const [actionsBarEl, setActionsBarEl] = useState<HTMLElement | null>(null);
    // Stage-travel arrows lock while a structural edit or save is pending: a stage jump is a
    // state change, not a router navigation, so the unsaved-changes guard would never prompt and
    // the edit would silently drop — same rule as the revisit card's item arrows.
    const [isEditorLocked, setIsEditorLocked] = useState(false);
    const lockedTravel = isEditorLocked ? { ...travel, prevDisabled: true, nextDisabled: true } : travel;
    const nav = useStageDecisionNavigation({ db, queue, onQueueChange, onUndoFailed: setToast });

    if (nav.revisitProps) {
        return <RevisitDecisionCard db={db} {...nav.revisitProps} travel={travel} />;
    }

    const currentId = currentQueueItemId(queue);
    // A `routine:` pseudo-entry (calendar stage collapse) reviews the whole series as one card.
    const entryRoutineId = currentId ? routineIdOfEntry(currentId) : null;
    if (entryRoutineId) {
        const entryRoutine = routines.find((routine) => routine._id === entryRoutineId);
        if (!entryRoutine) {
            // Routine vanished (deleted on another device) — the reconcile effect drops the entry
            // on the routines change it just observed. Keep the bar mounted (with the drop escape
            // hatch) so the walk is never controlless if that commit is dropped.
            return (
                <Box className={styles.stageRoot} data-testid="focusStage">
                    <Box className={styles.centeredArea}>
                        <Paper elevation={1} className={styles.editorCard}>
                            <Typography variant="body1">This routine no longer exists on this device.</Typography>
                        </Paper>
                    </Box>
                    <StageActionBar travel={travel}>
                        <StageNavButtons {...nav.blockedNavProps('focusBlockedSkip')} />
                    </StageActionBar>
                </Box>
            );
        }
        return <RoutineReviewCard routine={entryRoutine} db={db} nav={nav} travel={travel} />;
    }
    const currentItem = currentId ? (allItems.find((item) => item._id === currentId) ?? null) : null;

    if (!currentId || !currentItem) {
        return (
            <StageEmptyCard
                // Stage-named so "all reviewed" reads as THIS stage being done, not the whole review.
                title={stageEndTitle(
                    { stageName: stage.title, allReviewed: `${stage.title} — all reviewed!`, empty: `${stage.title} — nothing to review` },
                    queue,
                )}
                onContinue={onStageFinished}
                onBack={nav.canGoBack ? nav.goBack : undefined}
                travel={travel}
            />
        );
    }

    const reassignInFlight = isPending('item', currentItem._id);
    // Undo policy: routine-generated items get none — their disposal already advanced the
    // routine's series, and a snapshot restore would double-book it. A no-write decision
    // ("Looks good") is undone by a bare requeue, so it carries an empty undo.
    const captureUndo = (): StageDecisionUndo | undefined => (currentItem.routineId ? undefined : { snapshot: currentItem });
    const captureNoWriteUndo = (): StageDecisionUndo | undefined => (currentItem.routineId ? undefined : {});

    async function decideWith(mutation: () => Promise<unknown>) {
        const undo = captureUndo();
        await mutation();
        // `refreshItems()` only schedules the snapshot swap — it resolves before the wizard's
        // reconcile effect sees the new items, so the decision is guaranteed to shift off the item
        // we just mutated (not the next one). Load-bearing: if refresh ever becomes genuinely
        // awaited, reconcile could drop the id first and the decision would silently skip its successor.
        await refreshItems();
        nav.recordDecision(undo);
    }

    const onDone = () => decideWith(() => clarifyToDone(db, currentItem, { onReadOnlyGCal: () => setToast(FROM_GMAIL_READONLY_MESSAGE) }));
    const onTrash = () => decideWith(() => clarifyToTrash(db, currentItem));
    const onRelease = () => decideWith(() => releaseFromTickler(db, currentItem));

    const renderActions = (api: ItemEditorActionsApi) => (
        <>
            <StageNavButtons {...nav.liveNavProps(api.isSaving)} />
            {stage.id === 'somedayMaybe' ? (
                <Button color="warning" disabled={api.isSaving} onClick={() => void onTrash()} data-testid="focusTrash">
                    Trash
                </Button>
            ) : (
                <Button disabled={api.isSaving} onClick={() => void onDone()} data-testid="focusDone">
                    Done
                </Button>
            )}
            {stage.id === 'tickler' && (
                <Button disabled={api.isSaving} onClick={() => void onRelease()} data-testid="focusRelease">
                    Release now
                </Button>
            )}
            {/* Dirty-aware primary: untouched → advance without a write; edited → the body's save
                path commits, then its post-save onClose completes the item out of the queue. The
                label also acknowledges autosaved text edits (hasTextEdits), which need no explicit
                save — the debounced commit (or the unmount flush) lands them either way. A routine
                destination is a compound write no snapshot can reverse, so it arms no undo. */}
            <Button
                variant="contained"
                disabled={api.isDirty ? api.saveDisabled : api.isSaving}
                onClick={
                    api.isDirty
                        ? () => nav.armExplicitSave(api.isRoutineDestination ? undefined : captureUndo(), api.triggerSave)
                        : () => nav.recordDecision(captureNoWriteUndo())
                }
                data-testid="focusKeep"
            >
                {api.isDirty || api.hasTextEdits ? 'Save & next' : 'Looks good'}
            </Button>
        </>
    );

    // Routine-generated items get a prominent strip above the editor ("review the pattern, not
    // the copy"); a calendar occurrence individually moved off the pattern is labeled an exception.
    const itemRoutine = currentItem.routineId ? routines.find((routine) => routine._id === currentItem.routineId) : undefined;
    const isExceptionItem = Boolean(itemRoutine && isModifiedExceptionItem(itemRoutine, currentItem));

    return (
        <Box className={styles.stageRoot} data-testid="focusStage">
            <Paper elevation={3} className={styles.editorCard}>
                {currentItem.routineId && <RoutineReviewBanner routine={itemRoutine} isException={isExceptionItem} routineId={currentItem.routineId} />}
                <ItemEditorBody
                    key={currentItem._id}
                    item={currentItem}
                    db={db}
                    people={people}
                    workContexts={workContexts}
                    onClose={nav.closeAsDecisionOrSkip}
                    onSaved={refreshItems}
                    onSaveCommitted={nav.markSaveCommitted}
                    onDirtyLockChange={setIsEditorLocked}
                    onFromGmailReadOnly={() => setToast(FROM_GMAIL_READONLY_MESSAGE)}
                    chrome="page"
                    renderActions={renderActions}
                    actionsContainer={actionsBarEl}
                />
            </Paper>
            <StageActionBar onBarMounted={setActionsBarEl} travel={lockedTravel}>
                {reassignInFlight && <StageNavButtons {...nav.blockedNavProps('focusBlockedSkip')} />}
            </StageActionBar>
            <Snackbar open={Boolean(toast)} autoHideDuration={3000} onClose={() => setToast('')} message={toast} />
        </Box>
    );
}
