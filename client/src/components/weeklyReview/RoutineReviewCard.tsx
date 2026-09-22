import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlined';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Snackbar from '@mui/material/Snackbar';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import type { IDBPDatabase } from 'idb';
import { type ComponentProps, useState } from 'react';
import { useAppData } from '../../contexts/AppDataProvider';
import { usePendingReassign } from '../../contexts/PendingReassignProvider';
import { clarifyToDone, FROM_GMAIL_READONLY_MESSAGE } from '../../db/itemMutations';
import { pauseRoutine } from '../../db/routineMutations';
import { useCalendarOptions } from '../../hooks/useCalendarOptions';
import { useNewTabAwareNavigate } from '../../lib/newTabNavigation';
import { isOverdueCalendarItem } from '../../lib/routineNextItem';
import type { MyDB, StoredRoutine } from '../../types/MyDB';
import { CalendarEventLinks } from '../itemEditor/CalendarEventLinks';
import { MeetingDetails } from '../itemEditor/MeetingDetails';
import { MarkdownPreview } from '../markdown/MarkdownPreview';
import { PauseRoutineConfirmDialog } from '../routines/PauseRoutineConfirmDialog';
import { RoutineDialog } from '../routines/RoutineDialog';
import { RoutineReviewBanner } from './RoutineReviewBanner';
import styles from './RoutineReviewCard.module.css';
import type { StageDecisionUndo } from './reviewFlowState';
import {
    actionableOccurrence,
    collapsedOccurrences,
    formatOccurrenceRelative,
    formatOccurrenceWhen,
    occurrenceSummary,
    representativeEventItem,
    sortAnchorOccurrence,
} from './routineReviewCardLogic';
import { StageActionBar, type StageTravel } from './StageActionBar';
import { StageCardScroller } from './StageCardScroller';
import { StageNavButtons } from './StageNavButtons';
import stageStyles from './stageLayout.module.css';

/** The slice of the stage's decision-navigation API a routine entry uses (no editor handshake). */
interface RoutineEntryDecisionNav {
    recordDecision: (undo?: StageDecisionUndo) => void;
    liveNavProps: (isSaving: boolean) => ComponentProps<typeof StageNavButtons>;
}

interface RoutineReviewCardProps {
    routine: StoredRoutine;
    db: IDBPDatabase<MyDB>;
    nav: RoutineEntryDecisionNav;
    travel: StageTravel;
}

/**
 * The calendar stage's collapsed routine entry. It reads like the one-off calendar entries around
 * it — the SAME date/time headline the stage sorted it by, then the same GCal event links and
 * meeting-details panel — with the routine distinction carried by the banner and the schedule line
 * rather than by a wholly different layout. The series still reviews as ONE card, so the actions
 * are routine-level (pause, edit, open page) instead of an item editor, and the meeting panel is
 * read-only: attendee edits on a series master belong in the routine editor, not a review glance.
 */
export function RoutineReviewCard({ routine, db, nav, travel }: RoutineReviewCardProps) {
    const { allItems, people, workContexts, refreshRoutines, refreshItems, syncAndRefresh } = useAppData();
    const { isPending } = usePendingReassign();
    const { options: calendarOptions } = useCalendarOptions();
    const navigateOrNewTab = useNewTabAwareNavigate();
    const [isPauseConfirmOpen, setIsPauseConfirmOpen] = useState(false);
    const [isEditorOpen, setIsEditorOpen] = useState(false);
    // useState (not useTransition): the pause flow carries an error message alongside the pending
    // flag — the richer-than-one-boolean exception to the useTransition default.
    const [isPausing, setIsPausing] = useState(false);
    // Same richer-than-a-boolean reason as the pause flow: completing surfaces its own error text.
    const [isCompleting, setIsCompleting] = useState(false);
    const [toast, setToast] = useState('');
    // A mid-flight cross-account reassign would misroute the pause's item-trashing writes — same
    // guard RoutineDialog applies to edits.
    const reassignInFlight = isPending('routine', routine._id);
    // Same rule as FocusStage / RevisitDecisionCard: a stage jump is a state change the
    // router-based unsaved-changes guard can never see, so lock travel while the routine editor
    // is open or a pause write is in flight.
    const isBusy = isPausing || isCompleting || isEditorOpen;
    const lockedTravel = isBusy ? { ...travel, prevDisabled: true, nextDisabled: true } : travel;

    const occurrences = collapsedOccurrences(routine, allItems);
    // The occurrence the calendar stage ranked this entry by — leading with any other date would
    // contradict the position the card holds in the walk.
    const anchor = sortAnchorOccurrence(occurrences);
    const whenLabel = formatOccurrenceWhen(anchor);
    const relativeLabel = formatOccurrenceRelative(anchor);
    // GCal meeting metadata lives on the series master; location / meeting link mirror onto the
    // occurrence. Project both onto one item so the shared calendar components can render it.
    const eventItem = representativeEventItem(routine, anchor);
    // A past-but-still-open occurrence is overdue, not absent — flagged so the card says why the
    // date it leads with has already gone by.
    const isAnchorOverdue = Boolean(anchor && isOverdueCalendarItem(anchor));
    // What "Mark done" completes — the same occurrence the routine page offers, which for an
    // all-past series is the MOST RECENT one, not the earliest (which only sets card position).
    const actionable = actionableOccurrence(routine, occurrences);
    const isActionableOverdue = Boolean(actionable && isOverdueCalendarItem(actionable));
    const notes = routine.template.notes;

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
            setToast('Could not pause the routine — nothing changed.');
            return;
        } finally {
            setIsPausing(false);
        }
        // Only after the pause landed: irreversible from the review's point of view (items
        // trashed + GCal cap) — no undo.
        nav.recordDecision(undefined);
        // Fire-and-forget: push the pause + pull the GCal-cap echo without holding up the walk.
        void syncAndRefresh();
    }

    /**
     * Complete the occurrence the card leads with. `clarifyToDone` advances the series
     * (`maybeCreateNextRoutineItem`), so like every routine-generated disposal in the review this
     * arms NO undo — a snapshot restore would double-book the series. The entry itself stays
     * decided either way; only the occurrence is written.
     */
    async function onMarkOccurrenceDone() {
        if (!actionable) {
            return;
        }
        setIsCompleting(true);
        try {
            await clarifyToDone(db, actionable, { onReadOnlyGCal: () => setToast(FROM_GMAIL_READONLY_MESSAGE) });
            await refreshItems();
        } catch (err) {
            console.error('[weekly-review] mark routine occurrence done failed:', err);
            setToast('Could not mark the occurrence done — nothing changed.');
            return;
        } finally {
            setIsCompleting(false);
        }
        nav.recordDecision(undefined);
        void syncAndRefresh();
    }

    const onRoutineSaved = async () => {
        await refreshRoutines();
        await refreshItems();
    };

    // Never called: the panel is mounted read-only, which short-circuits both callbacks.
    const noopAsync = async () => {};

    return (
        <Box className={stageStyles.stageRoot} data-testid="routineReviewCard">
            <StageCardScroller>
                <Paper elevation={3} className={stageStyles.editorCard}>
                    <RoutineReviewBanner routine={routine} isException={false} routineId={routine._id} />
                    {whenLabel && (
                        <Box className={styles.whenRow}>
                            <Typography variant="h6" component="p" data-testid="routineCardWhen">
                                {whenLabel}
                            </Typography>
                            {relativeLabel && (
                                <Typography variant="body2" color="text.secondary" data-testid="routineCardWhenRelative">
                                    {relativeLabel}
                                </Typography>
                            )}
                            {isAnchorOverdue && <Chip label="Overdue" color="warning" size="small" data-testid="routineCardOverdueChip" />}
                        </Box>
                    )}
                    {/* No repeat icon here: the banner above already carries it — a second one made the
                    title read as a different KIND of entry than the one-offs around it. */}
                    <Box className={styles.titleRow}>
                        <Typography variant="h5" data-testid="routineCardTitle">
                            {routine.title}
                        </Typography>
                        <Tooltip title="Open routine page">
                            <IconButton
                                size="small"
                                onClick={(e) => navigateOrNewTab(e, { to: '/routine/$routineId', params: { routineId: routine._id } })}
                                data-testid="routineCardOpenPage"
                            >
                                <OpenInNewIcon fontSize="small" />
                            </IconButton>
                        </Tooltip>
                    </Box>
                    <Typography variant="body2" color="text.secondary" className={styles.occurrences} data-testid="routineCardOccurrences">
                        {occurrenceSummary(occurrences, anchor)}
                    </Typography>
                    {notes && (
                        <Box className={styles.notes} data-testid="routineCardNotes">
                            <MarkdownPreview markdown={notes} />
                        </Box>
                    )}
                    {eventItem && (
                        <Box className={styles.eventDetails}>
                            <CalendarEventLinks item={eventItem} calendarOptions={calendarOptions} />
                            <MeetingDetails item={eventItem} db={db} readOnly onRsvp={noopAsync} onAttendeesChange={noopAsync} />
                        </Box>
                    )}
                </Paper>
            </StageCardScroller>
            <StageActionBar travel={lockedTravel}>
                <StageNavButtons {...nav.liveNavProps(isBusy)} />
                {actionable && (
                    <Button
                        startIcon={<CheckCircleOutlineIcon />}
                        disabled={isBusy || reassignInFlight}
                        onClick={() => void onMarkOccurrenceDone()}
                        data-testid="routineCardMarkOccurrenceDone"
                    >
                        {isActionableOverdue ? 'Mark overdue done' : 'Mark done'}
                    </Button>
                )}
                {routine.active && (
                    <Button disabled={isBusy || reassignInFlight} onClick={() => setIsPauseConfirmOpen(true)} data-testid="routineCardPause">
                        Pause
                    </Button>
                )}
                <Button disabled={isBusy || reassignInFlight} onClick={() => setIsEditorOpen(true)} data-testid="routineCardEdit">
                    Edit
                </Button>
                <Button variant="contained" disabled={isBusy} onClick={() => nav.recordDecision({})} data-testid="routineCardLooksGood">
                    Looks good
                </Button>
            </StageActionBar>
            <PauseRoutineConfirmDialog
                routine={isPauseConfirmOpen ? routine : null}
                onCancel={() => setIsPauseConfirmOpen(false)}
                onConfirm={() => void onPauseConfirmed()}
            />
            {/* RoutineDialog directly (not useRoutineEditor): the review pins the dialog variant —
                page-mode clarify would navigate away from the live walk, and expand/popover have no
                row anchor here — and owning the open flag is what lets isBusy lock stage travel. */}
            {isEditorOpen && (
                <RoutineDialog
                    db={db}
                    userId={routine.userId}
                    workContexts={workContexts}
                    people={people}
                    routine={routine}
                    onClose={() => setIsEditorOpen(false)}
                    onSaved={onRoutineSaved}
                />
            )}
            <Snackbar open={Boolean(toast)} autoHideDuration={3000} onClose={() => setToast('')} message={toast} />
        </Box>
    );
}
