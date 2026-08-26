import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import type { IDBPDatabase } from 'idb';
import { useState } from 'react';
import { useAppData } from '../../contexts/AppDataProvider';
import { usePendingReassign } from '../../contexts/PendingReassignProvider';
import { formatRoutineSchedule } from '../../lib/rruleUtils';
import type { MyDB } from '../../types/MyDB';
import { ItemEditorBody } from '../itemEditor/ItemEditorBody';
import { DisabledCapableTooltip } from './DisabledCapableTooltip';
import { routineIdOfEntry, type StageDecision } from './reviewFlowState';
import { StageActionBar, type StageTravel } from './StageActionBar';
import { StageNavButtons } from './StageNavButtons';
import styles from './stageLayout.module.css';

interface RevisitDecisionCardProps {
    decision: StageDecision;
    db: IDBPDatabase<MyDB>;
    /** 1-based chronological position of this decision within the stage, for orientation. */
    position: { index: number; total: number };
    /** False at the oldest decision — ◀ has nowhere further to go. */
    canGoBack: boolean;
    onGoBack: () => void;
    /** One step toward the live queue (lands there from the newest decision). */
    onGoForward: () => void;
    onUndoDecision: () => void;
    isUndoing: boolean;
    /** Escape / post-save close — jumps straight back to the live queue. */
    onExit: () => void;
    travel: StageTravel;
}

/**
 * Back-arrow view over one already-made decision: the full editor opens on the item (manual fixes
 * save in place), and "Undo decision" — always rendered, disabled when the decision recorded no
 * undo — restores the pre-decision snapshot and requeues the item. Routine-generated items and
 * clarify-to-routine record none (see StageDecision.undo).
 */
export function RevisitDecisionCard({
    decision,
    db,
    position,
    canGoBack,
    onGoBack,
    onGoForward,
    onUndoDecision,
    isUndoing,
    onExit,
    travel,
}: RevisitDecisionCardProps) {
    // `routines` (visible accounts) matches the wizard's queue producer — see FocusStage.
    const { allItems, routines, people, workContexts, refreshItems } = useAppData();
    const { isPending } = usePendingReassign();
    // Portal target for the editor's action row — state (not a ref) so ItemEditorBody re-renders
    // and portals the buttons in once the pinned bar element mounts.
    const [actionsBarEl, setActionsBarEl] = useState<HTMLElement | null>(null);
    // Stage-travel arrows lock while a structural edit or save is pending — same rule (and same
    // rationale) as this card's item-level arrows below: a stage jump is a state change the
    // router-based unsaved-changes guard can never see.
    const [isEditorLocked, setIsEditorLocked] = useState(false);
    const lockedTravel = isEditorLocked ? { ...travel, prevDisabled: true, nextDisabled: true } : travel;

    const revisitedRoutineId = routineIdOfEntry(decision.itemId);
    const item = revisitedRoutineId ? null : (allItems.find((candidate) => candidate._id === decision.itemId) ?? null);
    const navProps = (disabled: boolean) => ({
        onBack: onGoBack,
        backDisabled: !canGoBack || disabled,
        forward: { onForward: onGoForward, disabled, label: 'Forward' },
    });

    // A collapsed calendar-routine entry has no item editor — the revisit view is a read-only
    // summary; its "Looks good" was a no-write decision, so Undo is a bare requeue.
    if (revisitedRoutineId) {
        const routine = routines.find((candidate) => candidate._id === revisitedRoutineId) ?? null;
        return (
            <RevisitSummaryShell
                travel={travel}
                actions={
                    <>
                        <StageNavButtons {...navProps(false)} />
                        <Button color="inherit" onClick={onUndoDecision} disabled={!decision.undo || !routine || isUndoing} data-testid="revisitUndoDecision">
                            Undo decision
                        </Button>
                    </>
                }
            >
                <Typography variant="overline" color="text.secondary" data-testid="revisitPositionLabel">
                    Already reviewed · {position.index} of {position.total}
                </Typography>
                <Typography variant="h6">{routine ? routine.title : 'This routine no longer exists on this device.'}</Typography>
                {routine && (
                    <Typography variant="body2" color="text.secondary">
                        {formatRoutineSchedule(routine)}
                    </Typography>
                )}
            </RevisitSummaryShell>
        );
    }

    // The editor renders (and portals) nothing for a hard-deleted item or one whose reassign is
    // in flight — the bar then owns the arrows so navigation always survives.
    if (!item || isPending('item', item._id)) {
        return (
            <RevisitSummaryShell travel={travel} actions={<StageNavButtons {...navProps(false)} />}>
                <Typography variant="body1">{item ? 'This item is moving to another account.' : 'This item no longer exists on this device.'}</Typography>
            </RevisitSummaryShell>
        );
    }

    return (
        <Box className={styles.stageRoot} data-testid="revisitDecisionCard">
            <Paper elevation={3} className={styles.editorCard}>
                <Typography variant="overline" color="text.secondary" data-testid="revisitPositionLabel">
                    Already reviewed · {position.index} of {position.total}
                </Typography>
                <ItemEditorBody
                    key={item._id}
                    item={item}
                    db={db}
                    people={people}
                    workContexts={workContexts}
                    onClose={onExit}
                    onSaved={refreshItems}
                    onDirtyLockChange={setIsEditorLocked}
                    chrome="page"
                    renderActions={(api) => (
                        <>
                            {/* Arrows lock while a structural edit is pending — navigating away here
                                is a state change, not a router navigation, so the unsaved-changes
                                guard would never prompt and the edit would silently drop. */}
                            <StageNavButtons {...navProps(api.isDirty || api.isSaving)} />
                            {/* Always rendered — disabled (with the reason) when the decision
                                recorded no undo — so the bar's buttons never shift position while
                                stepping through the history. */}
                            <DisabledCapableTooltip
                                title={decision.undo ? '' : 'This decision changed more than a snapshot can restore'}
                                wrapperTestId="revisitUndoWrapper"
                            >
                                <Button
                                    color="inherit"
                                    onClick={onUndoDecision}
                                    disabled={!decision.undo || isUndoing || api.isSaving}
                                    data-testid="revisitUndoDecision"
                                >
                                    Undo decision
                                </Button>
                            </DisabledCapableTooltip>
                            {/* Manual-fix path: structural edits (e.g. flipping a wrong Done's status
                                chip) commit here; text edits autosave and need no explicit save.
                                Note: a manual save does NOT refresh the decision's undo snapshot —
                                a subsequent Undo reverts past the manual fix too. */}
                            <Button variant="contained" disabled={!api.isDirty || api.saveDisabled} onClick={api.triggerSave} data-testid="revisitSave">
                                Save
                            </Button>
                        </>
                    )}
                    actionsContainer={actionsBarEl}
                />
            </Paper>
            <StageActionBar onBarMounted={setActionsBarEl} travel={lockedTravel} />
        </Box>
    );
}

interface RevisitSummaryShellProps {
    travel: StageTravel;
    /** Bar-owned actions — the read-only branches have no editor to portal buttons from. */
    actions: React.ReactNode;
    children: React.ReactNode;
}

/** Shared shell of the read-only revisit branches (routine entry, missing item): centered summary card + pinned bar. */
function RevisitSummaryShell({ travel, actions, children }: RevisitSummaryShellProps) {
    return (
        <Box className={styles.stageRoot} data-testid="revisitDecisionCard">
            <Box className={styles.centeredArea}>
                <Paper elevation={1} className={styles.editorCard}>
                    {children}
                </Paper>
            </Box>
            <StageActionBar travel={travel}>{actions}</StageActionBar>
        </Box>
    );
}
