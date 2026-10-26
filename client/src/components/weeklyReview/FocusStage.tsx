import type { IDBPDatabase } from 'idb';
import { useState } from 'react';
import { useAppData } from '../../contexts/AppDataProvider';
import { usePendingReassign } from '../../contexts/PendingReassignProvider';
import { clarifyToDone, clarifyToTrash, FROM_GMAIL_READONLY_MESSAGE, releaseFromTickler } from '../../db/itemMutations';
import { Button, Card, Text } from '../../designSystem';
import type { MyDB, StoredItem } from '../../types/MyDB';
import { FutureDoneConfirmDialog, useFutureDoneConfirm } from '../FutureDoneConfirmDialog';
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
import { StageCardScroller } from './StageCardScroller';
import { StageEmptyCard } from './StageEmptyCard';
import { StageNavButtons } from './StageNavButtons';
import styles from './stageLayout.module.css';
import { useStageDecisionNavigation } from './useStageDecisionNavigation';
import { StageToast, useStageToast } from './useStageToast';

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
    const stageToast = useStageToast();
    const futureDone = useFutureDoneConfirm(allItems);
    // Portal target for the editor's action row — state (not a ref) so ItemEditorBody re-renders
    // and portals the buttons in once the pinned bar element mounts.
    const [actionsBarEl, setActionsBarEl] = useState<HTMLElement | null>(null);
    // Stage-travel arrows lock while a structural edit or save is pending: a stage jump is a
    // state change, not a router navigation, so the unsaved-changes guard would never prompt and
    // the edit would silently drop — same rule as the revisit card's item arrows.
    const [isEditorLocked, setIsEditorLocked] = useState(false);
    const lockedTravel = isEditorLocked ? { ...travel, prevDisabled: true, nextDisabled: true } : travel;
    const nav = useStageDecisionNavigation({ db, queue, onQueueChange, onUndoFailed: stageToast.showError });

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
                <div className={styles.stageRoot} data-testid="focusStage">
                    <div className={styles.centeredArea}>
                        <Card padding="none" className={styles.editorCard}>
                            <Text>This routine no longer exists on this device.</Text>
                        </Card>
                    </div>
                    <StageActionBar travel={travel}>
                        <StageNavButtons {...nav.blockedNavProps('focusBlockedSkip')} />
                    </StageActionBar>
                </div>
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
    const currentEntryId = currentItem._id;
    // Undo policy: routine-generated items get none — their disposal already advanced the
    // routine's series, and a snapshot restore would double-book it. A no-write decision
    // ("Looks good") is undone by a bare requeue, so it carries an empty undo.
    const captureUndo = (): StageDecisionUndo | undefined => (currentItem.routineId ? undefined : { snapshot: currentItem });
    const captureNoWriteUndo = (): StageDecisionUndo | undefined => (currentItem.routineId ? undefined : {});

    async function decideWith(mutation: () => Promise<unknown>) {
        const undo = captureUndo();
        await mutation();
        await refreshItems();
        // Keyed by the item acted on: the refresh can let the wizard's reconcile drop it from the
        // queue first, and deciding "current" would then decide its successor instead.
        nav.recordDecision(currentEntryId, undo);
    }

    const onDone = (target: StoredItem) =>
        decideWith(() => clarifyToDone(db, target, { onReadOnlyGCal: () => stageToast.showNotice(FROM_GMAIL_READONLY_MESSAGE) }));
    const onTrash = () => decideWith(() => clarifyToTrash(db, currentItem));
    const onRelease = () => decideWith(() => releaseFromTickler(db, currentItem));

    const renderActions = (api: ItemEditorActionsApi) => (
        <>
            <StageNavButtons {...nav.liveNavProps(api.isSaving)} />
            {stage.id === 'somedayMaybe' ? (
                <Button tone="danger" disabled={api.isSaving} onClick={() => void onTrash()} data-testid="focusTrash">
                    Trash
                </Button>
            ) : (
                <Button disabled={api.isSaving} onClick={() => futureDone.confirmDone(currentItem, (latest) => void onDone(latest))} data-testid="focusDone">
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
                variant="solid"
                disabled={api.isDirty ? api.saveDisabled : api.isSaving}
                onClick={
                    api.isDirty
                        ? () => nav.armExplicitSave(api.isRoutineDestination ? undefined : captureUndo(), api.triggerSave)
                        : () => nav.recordDecision(currentEntryId, captureNoWriteUndo())
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
        <div className={styles.stageRoot} data-testid="focusStage">
            <StageCardScroller>
                <Card padding="none" className={styles.editorCard}>
                    {currentItem.routineId && <RoutineReviewBanner routine={itemRoutine} isException={isExceptionItem} routineId={currentItem.routineId} />}
                    <ItemEditorBody
                        key={currentItem._id}
                        item={currentItem}
                        db={db}
                        people={people}
                        workContexts={workContexts}
                        onClose={() => nav.closeAsDecisionOrSkip(currentEntryId)}
                        onSaved={refreshItems}
                        onSaveCommitted={nav.markSaveCommitted}
                        onDirtyLockChange={setIsEditorLocked}
                        onFromGmailReadOnly={() => stageToast.showNotice(FROM_GMAIL_READONLY_MESSAGE)}
                        presentation="review"
                        renderActions={renderActions}
                        actionsContainer={actionsBarEl}
                    />
                </Card>
            </StageCardScroller>
            <StageActionBar onBarMounted={setActionsBarEl} travel={lockedTravel}>
                {reassignInFlight && <StageNavButtons {...nav.blockedNavProps('focusBlockedSkip')} />}
            </StageActionBar>
            <StageToast {...stageToast.toastProps} />
            <FutureDoneConfirmDialog {...futureDone.dialogProps} />
        </div>
    );
}
