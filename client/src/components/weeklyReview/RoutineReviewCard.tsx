import LoopIcon from '@mui/icons-material/Loop';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import PlaceOutlinedIcon from '@mui/icons-material/PlaceOutlined';
import VideocamOutlinedIcon from '@mui/icons-material/VideocamOutlined';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Snackbar from '@mui/material/Snackbar';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { type ComponentProps, useState } from 'react';
import { useAppData } from '../../contexts/AppDataProvider';
import { usePendingReassign } from '../../contexts/PendingReassignProvider';
import { pauseRoutine } from '../../db/routineMutations';
import { useNewTabAwareNavigate } from '../../lib/newTabNavigation';
import { describeNextItemDate, findRoutineNextItem } from '../../lib/routineNextItem';
import { formatRoutineSchedule } from '../../lib/rruleUtils';
import { hasAtLeastOne } from '../../lib/typeUtils';
import type { MyDB, StoredItem, StoredRoutine } from '../../types/MyDB';
import { MarkdownPreview } from '../markdown/MarkdownPreview';
import { PauseRoutineConfirmDialog } from '../routines/PauseRoutineConfirmDialog';
import { RoutineDialog } from '../routines/RoutineDialog';
import styles from './RoutineReviewCard.module.css';
import { isModifiedExceptionItem, type StageDecisionUndo } from './reviewFlowState';
import { StageActionBar, type StageTravel } from './StageActionBar';
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
 * The calendar stage's collapsed routine entry: the whole series reviews as ONE card — title,
 * simplified schedule, occurrence summary, notes — with routine-level actions (pause, edit,
 * open page) instead of an item editor. "Looks good" decides the entry with a requeue-only undo;
 * pausing is a routine mutation and records an irreversible decision.
 */
export function RoutineReviewCard({ routine, db, nav, travel }: RoutineReviewCardProps) {
    const { allItems, people, workContexts, refreshRoutines, refreshItems, syncAndRefresh } = useAppData();
    const { isPending } = usePendingReassign();
    const navigateOrNewTab = useNewTabAwareNavigate();
    const [isPauseConfirmOpen, setIsPauseConfirmOpen] = useState(false);
    const [isEditorOpen, setIsEditorOpen] = useState(false);
    // useState (not useTransition): the pause flow carries an error message alongside the pending
    // flag — the richer-than-one-boolean exception to the useTransition default.
    const [isPausing, setIsPausing] = useState(false);
    const [toast, setToast] = useState('');
    // A mid-flight cross-account reassign would misroute the pause's item-trashing writes — same
    // guard RoutineDialog applies to edits.
    const reassignInFlight = isPending('routine', routine._id);
    // Same rule as FocusStage / RevisitDecisionCard: a stage jump is a state change the
    // router-based unsaved-changes guard can never see, so lock travel while the routine editor
    // is open or a pause write is in flight.
    const isBusy = isPausing || isEditorOpen;
    const lockedTravel = isBusy ? { ...travel, prevDisabled: true, nextDisabled: true } : travel;

    const occurrences = collapsedOccurrences(routine, allItems);
    const nextOccurrence = findRoutineNextItem(routine, [...occurrences], dayjs()).item ?? undefined;
    // Location / meeting link are GCal-owned per-occurrence mirrors — the next occurrence is the
    // series' representative (falling back to any occurrence for a fully-past series).
    const representative = nextOccurrence ?? (hasAtLeastOne(occurrences) ? occurrences[0] : undefined);
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

    const onRoutineSaved = async () => {
        await refreshRoutines();
        await refreshItems();
    };

    return (
        <Box className={stageStyles.stageRoot} data-testid="routineReviewCard">
            <Paper elevation={3} className={stageStyles.editorCard}>
                <Typography variant="overline" color="text.secondary" data-testid="routineCardOverline">
                    Routine — reviewed once for all its occurrences
                </Typography>
                <Box className={styles.titleRow}>
                    <LoopIcon className={styles.titleIcon} />
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
                <Box className={styles.metaList}>
                    <Typography variant="subtitle1" data-testid="routineCardSchedule">
                        {formatRoutineSchedule(routine)}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" data-testid="routineCardOccurrences">
                        {occurrenceSummary(occurrences, nextOccurrence)}
                    </Typography>
                    {representative?.location && (
                        <Box className={styles.metaRow}>
                            <PlaceOutlinedIcon fontSize="small" color="disabled" />
                            <Typography variant="body2" color="text.secondary" data-testid="routineCardLocation">
                                {representative.location}
                            </Typography>
                        </Box>
                    )}
                    {representative?.meetingLink && (
                        <Box className={styles.metaRow}>
                            <VideocamOutlinedIcon fontSize="small" color="disabled" />
                            <Link href={representative.meetingLink} target="_blank" rel="noopener" variant="body2" data-testid="routineCardMeetingLink">
                                {representative.meetingLink}
                            </Link>
                        </Box>
                    )}
                </Box>
                {notes && (
                    <Box className={styles.notes} data-testid="routineCardNotes">
                        <MarkdownPreview markdown={notes} />
                    </Box>
                )}
            </Paper>
            <StageActionBar travel={lockedTravel}>
                <StageNavButtons {...nav.liveNavProps(isBusy)} />
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

/** The occurrences this card stands for: the routine's calendar items minus modified exceptions (those review on their own). */
export function collapsedOccurrences(routine: StoredRoutine, allItems: ReadonlyArray<StoredItem>): StoredItem[] {
    return allItems
        .filter((item) => item.routineId === routine._id && item.status === 'calendar' && !isModifiedExceptionItem(routine, item))
        .sort((a, b) => (a.timeStart ?? '').localeCompare(b.timeStart ?? ''));
}

export function occurrenceSummary(occurrences: ReadonlyArray<StoredItem>, nextOccurrence: StoredItem | undefined): string {
    const count = `${occurrences.length} occurrence${occurrences.length === 1 ? '' : 's'} on the calendar`;
    return nextOccurrence ? `${count} · next ${describeNextItemDate(nextOccurrence)}` : count;
}
