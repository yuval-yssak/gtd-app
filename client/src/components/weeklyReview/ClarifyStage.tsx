import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Snackbar from '@mui/material/Snackbar';
import type { IDBPDatabase } from 'idb';
import { useState } from 'react';
import { useAppData } from '../../contexts/AppDataProvider';
import { usePendingReassign } from '../../contexts/PendingReassignProvider';
import { FROM_GMAIL_READONLY_MESSAGE } from '../../db/itemMutations';
import type { MyDB } from '../../types/MyDB';
import { type ItemEditorActionsApi, ItemEditorBody } from '../itemEditor/ItemEditorBody';
import { RevisitDecisionCard } from './RevisitDecisionCard';
import { currentQueueItemId, type StageDecisionUndo, type StageQueue, stageEndTitle } from './reviewFlowState';
import { StageActionBar, type StageTravel } from './StageActionBar';
import { StageEmptyCard } from './StageEmptyCard';
import { StageNavButtons } from './StageNavButtons';
import styles from './stageLayout.module.css';
import { useStageDecisionNavigation } from './useStageDecisionNavigation';

interface ClarifyStageProps {
    queue: StageQueue;
    db: IDBPDatabase<MyDB>;
    /** Functional: the transform is applied to the LATEST queue, composing with same-tick commits. */
    onQueueChange: (updateQueue: (queue: StageQueue) => StageQueue) => void;
    onStageFinished: () => void;
    travel: StageTravel;
}

/**
 * Solo clarify: the full item editor (status chips, per-status forms, routine conversion) hosted
 * one inbox item at a time. The ▶ arrow steps past an item (the walk is linear and ENDS at the
 * stage-end card — no cycling); the ◀ arrow steps back to skipped items and then revisits past
 * clarifications (with one-click undo back to inbox).
 */
export function ClarifyStage({ queue, db, onQueueChange, onStageFinished, travel }: ClarifyStageProps) {
    const { allItems, people, workContexts, refreshItems } = useAppData();
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
    const currentItem = currentId ? (allItems.find((item) => item._id === currentId) ?? null) : null;

    if (!currentId || !currentItem) {
        return (
            <StageEmptyCard
                // Skipped-past captures are called out — ending the walk didn't clear them.
                title={stageEndTitle({ stageName: 'Inbox', allReviewed: 'Inbox clear!', empty: 'Inbox was already clear' }, queue)}
                onContinue={onStageFinished}
                onBack={nav.canGoBack ? nav.goBack : undefined}
                travel={travel}
            />
        );
    }

    const reassignInFlight = isPending('item', currentItem._id);
    // Inbox captures are never routine-generated, but apply the same undo policy as the focus
    // stages anyway. The routine DESTINATION is excluded at the save click (isRoutineDestination):
    // clarify-to-routine is a compound write (routine + seeded items + item trash) that a bare
    // snapshot restore would leave orphaned.
    const captureUndo = (): StageDecisionUndo | undefined => (currentItem.routineId ? undefined : { snapshot: currentItem });

    return (
        <Box className={styles.stageRoot} data-testid="clarifyStage">
            <Paper elevation={3} className={styles.editorCard}>
                <ItemEditorBody
                    key={currentItem._id}
                    item={currentItem}
                    db={db}
                    people={people}
                    workContexts={workContexts}
                    // A committed clarify IS the decision (onSaveCommitted → post-save onClose);
                    // an Escape-driven onClose steps past the item instead (still undecided).
                    onClose={nav.closeAsDecisionOrSkip}
                    onSaved={refreshItems}
                    onSaveCommitted={nav.markSaveCommitted}
                    onDirtyLockChange={setIsEditorLocked}
                    onFromGmailReadOnly={() => setToast(FROM_GMAIL_READONLY_MESSAGE)}
                    chrome="page"
                    renderActions={(api: ItemEditorActionsApi) => (
                        <>
                            <StageNavButtons {...nav.liveNavProps(api.isSaving)} />
                            <Button
                                variant="contained"
                                disabled={api.saveDisabled}
                                onClick={() => nav.armExplicitSave(api.isRoutineDestination ? undefined : captureUndo(), api.triggerSave)}
                                data-testid="clarifySaveNext"
                            >
                                Save & next
                            </Button>
                        </>
                    )}
                    actionsContainer={actionsBarEl}
                />
            </Paper>
            <StageActionBar onBarMounted={setActionsBarEl} travel={lockedTravel}>
                {reassignInFlight && <StageNavButtons {...nav.blockedNavProps('clarifyBlockedSkip')} />}
            </StageActionBar>
            <Snackbar open={Boolean(toast)} autoHideDuration={3000} onClose={() => setToast('')} message={toast} />
        </Box>
    );
}
