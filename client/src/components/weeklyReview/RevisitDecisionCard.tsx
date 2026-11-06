import type { IDBPDatabase } from 'idb';
import { useState } from 'react';
import { useAppData } from '../../contexts/AppDataProvider';
import { usePendingReassign } from '../../contexts/PendingReassignProvider';
import { Button, Card, Text } from '../../designSystem';
import { formatRoutineSchedule } from '../../lib/rruleUtils';
import type { MyDB, StoredItem, StoredRoutine } from '../../types/MyDB';
import { DisabledCapableTooltip } from '../DisabledCapableTooltip';
import { ItemEditorBody } from '../itemEditor/ItemEditorBody';
import { RoutineReviewBanner } from './RoutineReviewBanner';
import { routineIdOfEntry, type StageDecision, undoUnavailableReason } from './reviewFlowState';
import { revisitedOccurrence } from './routineReviewCardLogic';
import { StageActionBar, type StageTravel } from './StageActionBar';
import { StageCardScroller } from './StageCardScroller';
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
    /**
     * Whether the editor offers its Position row, as the live card of the same stage does — the
     * tickler walks by wake-up date, so a row there would reorder a list the user is not looking at.
     */
    hasPositionRow: boolean;
    /**
     * A recurring event's occurrence was saved from the revisit editor — a time or text edit makes
     * it a modified exception, its own calendar entry, which must not re-join the walk.
     */
    onRoutineOccurrenceSaved?: (occurrenceId: string) => void;
}

/**
 * Back-arrow view over one already-made decision: the full editor opens on the item (manual fixes
 * save in place), and "Undo decision" — always rendered, disabled with the reason when the
 * decision recorded no undo — restores the pre-decision snapshot and requeues the item.
 * Routine-generated items and clarify-to-routine record none (see StageDecision.undo). A
 * collapsed recurring event reopens the editor on the occurrence it was decided over, under the
 * same routine banner as its live card.
 */
export function RevisitDecisionCard(props: RevisitDecisionCardProps) {
    // `routines` (visible accounts) matches the wizard's queue producer — see FocusStage.
    const { allItems, routines } = useAppData();
    const { isPending } = usePendingReassign();
    const { decision } = props;

    const revisitedRoutineId = routineIdOfEntry(decision.itemId);
    const routine = revisitedRoutineId ? (routines.find((candidate) => candidate._id === revisitedRoutineId) ?? null) : null;
    const item = routine
        ? (revisitedOccurrence(routine, allItems, decision.occurrenceId) ?? null)
        : (allItems.find((candidate) => candidate._id === decision.itemId) ?? null);

    // The editor renders (and portals) nothing for a hard-deleted item or one whose reassign is
    // in flight — the bar then owns the arrows so navigation always survives.
    if (item && !isPending('item', item._id)) {
        return <RevisitEditorCard {...props} item={item} routine={routine} />;
    }
    if (revisitedRoutineId) {
        return <RevisitRoutineSummary {...props} routine={routine} />;
    }
    return (
        <RevisitSummaryShell travel={props.travel} actions={<StageNavButtons {...revisitNavProps(props, false)} />}>
            <Text>{item ? 'This item is moving to another account.' : 'This item no longer exists on this device.'}</Text>
        </RevisitSummaryShell>
    );
}

/** The revisit card's ◀ / ▶ — locked while the editor holds an unsaved edit or a save. */
function revisitNavProps({ canGoBack, onGoBack, onGoForward }: RevisitDecisionCardProps, isLocked: boolean) {
    return {
        onBack: onGoBack,
        backDisabled: !canGoBack || isLocked,
        forward: { onForward: onGoForward, disabled: isLocked, label: 'Forward' },
    };
}

interface RevisitEditorCardProps extends RevisitDecisionCardProps {
    item: StoredItem;
    /** Set when the decision was a collapsed recurring event and `item` is its occurrence. */
    routine: StoredRoutine | null;
}

/** The full-editor revisit: the decided item, or a recurring event's decided occurrence under its routine banner. */
function RevisitEditorCard(props: RevisitEditorCardProps) {
    const { item, routine, decision, db, position, onUndoDecision, isUndoing, onExit, travel, hasPositionRow, onRoutineOccurrenceSaved } = props;
    const { people, workContexts, refreshItems, refreshRoutines } = useAppData();
    // Portal target for the editor's action row — state (not a ref) so ItemEditorBody re-renders
    // and portals the buttons in once the pinned bar element mounts.
    const [actionsBarEl, setActionsBarEl] = useState<HTMLElement | null>(null);
    // Stage-travel arrows lock while a structural edit or save is pending — same rule (and same
    // rationale) as this card's item-level arrows below: a stage jump is a state change the
    // router-based unsaved-changes guard can never see.
    const [isEditorLocked, setIsEditorLocked] = useState(false);
    const lockedTravel = isEditorLocked ? { ...travel, prevDisabled: true, nextDisabled: true } : travel;

    // An occurrence edit records a `modified` exception on the routine row, so both refresh.
    async function onOccurrenceSaved() {
        onRoutineOccurrenceSaved?.(item._id);
        await refreshRoutines();
        await refreshItems();
    }

    return (
        <div className={styles.stageRoot} data-testid="revisitDecisionCard">
            <StageCardScroller>
                <Card padding="none" className={styles.editorCard}>
                    <Text variant="overline" tone="secondary" data-testid="revisitPositionLabel">
                        Already reviewed · {position.index} of {position.total}
                    </Text>
                    {routine && <RoutineReviewBanner routine={routine} isException={false} routineId={routine._id} />}
                    <ItemEditorBody
                        key={item._id}
                        item={item}
                        db={db}
                        people={people}
                        workContexts={workContexts}
                        onClose={onExit}
                        onSaved={routine ? onOccurrenceSaved : refreshItems}
                        onDirtyLockChange={setIsEditorLocked}
                        // Same density as the live stages: this is the review, and without it a
                        // long-notes item overflows the card here exactly as it did there.
                        presentation="review"
                        // No onPositionMoved: a decided item is out of the walk, so a move never swaps this card.
                        // Occurrences are not ranked — the live routine card shows no Position row either.
                        hasPositionRow={hasPositionRow && !routine}
                        // As on the live routine card: an occurrence text edit is a routine exception,
                        // so it waits for the explicit Save instead of autosaving mid-card.
                        isTextAutosaveAllowed={!routine}
                        renderActions={(api) => (
                            <>
                                {/* Arrows lock while a structural edit is pending — navigating away here
                                is a state change, not a router navigation, so the unsaved-changes
                                guard would never prompt and the edit would silently drop. */}
                                <StageNavButtons {...revisitNavProps(props, api.isDirty || api.isSaving)} />
                                <UndoDecisionButton decision={decision} onUndoDecision={onUndoDecision} disabled={isUndoing || api.isSaving} />
                                {/* Manual-fix path: structural edits (e.g. flipping a wrong Done's status
                                chip) commit here; text edits autosave and need no explicit save —
                                except on a recurring event's occurrence, where text waits for Save too.
                                Note: a manual save does NOT refresh the decision's undo snapshot —
                                a subsequent Undo reverts past the manual fix too, a Position-row move included. */}
                                <Button variant="solid" disabled={!api.isDirty || api.saveDisabled} onClick={api.triggerSave} data-testid="revisitSave">
                                    Save
                                </Button>
                            </>
                        )}
                        actionsContainer={actionsBarEl}
                    />
                </Card>
            </StageCardScroller>
            <StageActionBar onBarMounted={setActionsBarEl} travel={lockedTravel} />
        </div>
    );
}

interface RevisitRoutineSummaryProps extends RevisitDecisionCardProps {
    routine: StoredRoutine | null;
}

/**
 * A recurring event with no occurrence left on this device (or one mid-reassign): read-only
 * summary. Undo stays available for a "Looks good" (a bare requeue) while the routine exists.
 */
function RevisitRoutineSummary(props: RevisitRoutineSummaryProps) {
    const { routine, decision, position, onUndoDecision, isUndoing, travel } = props;
    return (
        <RevisitSummaryShell
            travel={travel}
            actions={
                <>
                    <StageNavButtons {...revisitNavProps(props, false)} />
                    <UndoDecisionButton decision={decision} onUndoDecision={onUndoDecision} disabled={!routine || isUndoing} />
                </>
            }
        >
            <Text variant="overline" tone="secondary" data-testid="revisitPositionLabel">
                Already reviewed · {position.index} of {position.total}
            </Text>
            <Text variant="titleSm">{routine ? routine.title : 'This routine no longer exists on this device.'}</Text>
            {routine && (
                <Text variant="bodySm" tone="secondary">
                    {formatRoutineSchedule(routine)}
                </Text>
            )}
        </RevisitSummaryShell>
    );
}

interface UndoDecisionButtonProps {
    decision: StageDecision;
    onUndoDecision: () => void;
    /** Busy or blocked for a reason other than the decision itself being irreversible. */
    disabled: boolean;
}

/**
 * Always rendered — disabled, with the reason, when the decision recorded no undo — so the bar's
 * buttons never shift position while stepping through the history.
 */
function UndoDecisionButton({ decision, onUndoDecision, disabled }: UndoDecisionButtonProps) {
    return (
        <DisabledCapableTooltip title={undoUnavailableReason(decision) ?? ''} wrapperTestId="revisitUndoWrapper">
            <Button tone="neutral" onClick={onUndoDecision} disabled={!decision.undo || disabled} data-testid="revisitUndoDecision">
                Undo decision
            </Button>
        </DisabledCapableTooltip>
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
        <div className={styles.stageRoot} data-testid="revisitDecisionCard">
            <div className={styles.centeredArea}>
                <Card padding="none" className={styles.editorCard}>
                    {children}
                </Card>
            </div>
            <StageActionBar travel={travel}>{actions}</StageActionBar>
        </div>
    );
}
