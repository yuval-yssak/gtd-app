import CalendarTodayIcon from '@mui/icons-material/CalendarToday';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import LightbulbOutlinedIcon from '@mui/icons-material/LightbulbOutlined';
import MoveToInboxIcon from '@mui/icons-material/MoveToInbox';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import DialogActions from '@mui/material/DialogActions';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { useMemo, useState, useTransition } from 'react';
import { type RsvpPushStatus, rsvpOnline } from '../../api/calendarApi';
import type { ReassignItemEditPatch } from '../../api/syncApi';
import { useAppData } from '../../contexts/AppDataProvider';
import { usePendingReassign } from '../../contexts/PendingReassignProvider';
import {
    clarifyToCalendar,
    clarifyToDone,
    clarifyToInbox,
    clarifyToNextAction,
    clarifyToSomedayMaybe,
    clarifyToTrash,
    clarifyToWaitingFor,
    queueOfflineRsvp,
    recordRoutineInstanceModification,
    updateItem,
    updateItemAttendees,
    updateItemWithGcalMeta,
} from '../../db/itemMutations';
import { useCalendarOptions } from '../../hooks/useCalendarOptions';
import type { GCalAttendee, MyDB, StoredItem, StoredPerson, StoredWorkContext } from '../../types/MyDB';
import { AccountPicker } from '../AccountPicker';
import { CalendarFields } from '../clarify/CalendarFields';
import { NextActionFields } from '../clarify/NextActionFields';
import {
    buildCalendarMeta,
    buildNextActionMeta,
    buildWaitingForMeta,
    type CalendarFormState,
    emptyCalendar,
    type NextActionFormState,
    type WaitingForFormState,
} from '../clarify/types';
import { WaitingForFields } from '../clarify/WaitingForFields';
import {
    applyCalendarPatch,
    buildClarifyToDoneOpts,
    buildEditPatch,
    decideSavePath,
    type EditableStatus,
    type ItemEditorChrome,
    isSaveDisabled,
    mergeFormsIntoItem,
    normalizeTitleAndNotes,
    pickDefaultConfigForUser,
    shouldAutoFocusTitle,
    shouldDetachFromRoutine,
    stripRoutineId,
} from '../editItemDialogLogic';
import styles from './ItemEditorBody.module.css';
import { MeetingDetails, type RsvpStatus } from './MeetingDetails';
import { applyOptimisticRsvp, findSelfAttendee } from './meetingDetailsLogic';
import { NotesSection } from './NotesSection';
import { ReassignInFlightInline } from './ReassignInFlightInline';
import { SendUpdatesDialog } from './SendUpdatesDialog';
import { shouldFireSendUpdatesDialog } from './sendUpdatesDialogLogic';

export type { ItemEditorChrome } from '../editItemDialogLogic';

interface StatusChipConfig {
    value: EditableStatus;
    label: string;
    icon: React.ReactElement;
    color?: 'default' | 'primary' | 'success' | 'error';
}

const STATUS_CHIPS: StatusChipConfig[] = [
    { value: 'inbox', label: 'Inbox', icon: <MoveToInboxIcon fontSize="small" /> },
    { value: 'nextAction', label: 'Next Action', icon: <PlayArrowIcon fontSize="small" /> },
    { value: 'calendar', label: 'Calendar', icon: <CalendarTodayIcon fontSize="small" /> },
    { value: 'waitingFor', label: 'Waiting For', icon: <HourglassEmptyIcon fontSize="small" /> },
    { value: 'somedayMaybe', label: 'Someday / Maybe', icon: <LightbulbOutlinedIcon fontSize="small" /> },
    { value: 'done', label: 'Done', icon: <CheckCircleOutlineIcon fontSize="small" />, color: 'success' },
    { value: 'trash', label: 'Trash', icon: <DeleteOutlineIcon fontSize="small" />, color: 'error' },
];

/**
 * Surface the body exposes to a custom actions renderer. Wizards (batch Process Inbox) supply
 * their own Skip / Save-and-next buttons that need to drive the body's save lifecycle without
 * duplicating its 80-line cross-account / status-transition / routine-detach logic.
 */
export interface ItemEditorActionsApi {
    triggerSave: () => void;
    saveDisabled: boolean;
    isSaving: boolean;
    onClose: () => void;
}

export interface ItemEditorBodyProps {
    item: StoredItem;
    db: IDBPDatabase<MyDB>;
    people: StoredPerson[];
    workContexts: StoredWorkContext[];
    onClose: () => void;
    onSaved: () => Promise<void>;
    /**
     * Fired post-save when the user transitions a `fromGmail` calendar item to a status the server
     * would normally push to GCal. The body has no Snackbar of its own — the host (useItemEditor)
     * wires this to `setInstantToast` so the warning surfaces through the page's existing toast.
     */
    onFromGmailReadOnly?: () => void;
    /** Pre-selects the status chip on open. When omitted, defaults to item.status. */
    initialStatus?: EditableStatus;
    /** Determines which actions container is rendered and visual padding. Dialog wrapper sets 'dialog'. */
    chrome: ItemEditorChrome;
    /** Replaces the default Cancel/Save actions row. Wizards use this for Skip / Save-and-next. */
    renderActions?: (api: ItemEditorActionsApi) => React.ReactNode;
}

// Exported for unit testing — the all-day decode path (inclusive endDate from the +1-day exclusive
// stored value) is the form's only round-trip dependency on Phase 5's encoding.
export function itemToCalendarForm(item: StoredItem): CalendarFormState {
    if (!item.timeStart) {
        return emptyCalendar;
    }
    // All-day items store YYYY-MM-DD strings on timeStart/timeEnd (GCal exclusive-end preserved).
    // Decode the +1-day shift back to an inclusive endDate so the picker shows the date the user
    // would think of as "the last day"; a single-day event renders with endDate === '' (blank).
    if (item.allDay) {
        const startDate = item.timeStart;
        const inclusiveEnd = item.timeEnd ? dayjs(item.timeEnd).subtract(1, 'day').format('YYYY-MM-DD') : startDate;
        return {
            date: startDate,
            startTime: '',
            endTime: '',
            calendarSyncConfigId: item.calendarSyncConfigId ?? '',
            allDay: true,
            endDate: inclusiveEnd === startDate ? '' : inclusiveEnd,
        };
    }
    const start = dayjs(item.timeStart);
    const end = item.timeEnd ? dayjs(item.timeEnd) : start.add(1, 'hour');
    return {
        date: start.format('YYYY-MM-DD'),
        startTime: start.format('HH:mm'),
        endTime: end.format('HH:mm'),
        calendarSyncConfigId: item.calendarSyncConfigId ?? '',
        allDay: false,
        endDate: '',
    };
}

/** Resolves the body-class for the chrome variant. dialog/page render the bare flex column;
 *  expand and popover add their own padding/borders. */
function bodyClassFor(chrome: ItemEditorChrome): string {
    if (chrome === 'expand') return styles.bodyExpand;
    if (chrome === 'popover') return styles.bodyPopover;
    return styles.body;
}

/**
 * Unified item editor body — owns all state, save logic, and the per-status forms. Chrome wrappers
 * (Dialog/Popover/Collapse/page) supply only the surrounding container; the body's appearance is
 * tuned via `chrome` to match each variant.
 *
 * Wrappers MUST set `key={item._id}` so React remounts the body when the editor opens on a
 * different item — otherwise local form state would seed from the wrong item.
 */
export function ItemEditorBody({
    item,
    db,
    people,
    workContexts,
    onClose,
    onSaved,
    onFromGmailReadOnly,
    initialStatus,
    chrome,
    renderActions,
}: ItemEditorBodyProps) {
    const { options: calendarOptions } = useCalendarOptions();
    const { loggedInAccounts } = useAppData();
    const { runReassignWithOverlay, isPending } = usePendingReassign();
    const reassignInFlight = isPending('item', item._id);

    const [title, setTitle] = useState(item.title);
    const [notes, setNotes] = useState(item.notes ?? '');
    const [status, setStatus] = useState<EditableStatus>(initialStatus ?? item.status);
    const [ownerUserId, setOwnerUserId] = useState(item.userId);
    const [reassignError, setReassignError] = useState<string | null>(null);
    const [isSaving, startSaving] = useTransition();
    const isRoutineGenerated = Boolean(item.routineId);
    // Live mirror of the GCal-owned fields the meeting editor mutates. Seeded from `item` on mount
    // (the body remounts on `key={item._id}` per ItemEditorBody contract). Kept separate from
    // `calForm` because attendees aren't a calendar form input — they live on the item itself and
    // are pushed via their own queueSyncOp path (rsvp / attendee-update), independent of Save.
    const [liveAttendees, setLiveAttendees] = useState<GCalAttendee[] | undefined>(item.attendees);
    const [scopeMissingReconsentUrl, setScopeMissingReconsentUrl] = useState<string | null>(null);
    // Deferred save state. When the SendUpdatesDialog needs to fire we stash the normalized
    // title/notes here and resolve them when the user picks all/none/cancel.
    const [pendingSave, setPendingSave] = useState<{ trimmedTitle: string; trimmedNotes: string } | null>(null);

    const [naForm, setNaForm] = useState<NextActionFormState>({
        ignoreBefore: item.ignoreBefore ?? '',
        workContextIds: item.workContextIds ?? [],
        peopleIds: item.peopleIds ?? [],
        energy: item.energy ?? '',
        time: item.time?.toString() ?? '',
        urgent: item.urgent ?? false,
        focus: item.focus ?? false,
        expectedBy: item.expectedBy ?? '',
    });
    const [calForm, setCalForm] = useState<CalendarFormState>(itemToCalendarForm(item));
    const visibleCalendarOptions = useMemo(
        () => (ownerUserId === item.userId ? calendarOptions : calendarOptions.filter((opt) => opt.userId === ownerUserId)),
        [calendarOptions, ownerUserId, item.userId],
    );
    const [wfForm, setWfForm] = useState<WaitingForFormState>({
        waitingForPersonId: item.waitingForPersonId ?? '',
        expectedBy: item.expectedBy ?? '',
        ignoreBefore: item.ignoreBefore ?? '',
    });

    const saveDisabled = isSaveDisabled(title, status, calForm, wfForm) || isSaving;

    function onSave() {
        if (isSaving) {
            return;
        }
        const trimmedTitle = title.trim();
        if (!trimmedTitle) {
            return;
        }
        const trimmedNotes = notes.trim();
        const ownerChanged = ownerUserId !== item.userId;
        const statusChanged = status !== item.status;
        const path = decideSavePath(ownerChanged, statusChanged);
        if (path.kind === 'block') {
            setReassignError(path.error);
            return;
        }
        if (path.kind === 'reassign' && !validateReassign()) {
            return;
        }
        if (path.kind === 'reassign') {
            startReassignInBackground(buildEditPatch(item, trimmedTitle, trimmedNotes, status, naForm, calForm, wfForm), trimmedTitle);
            onClose();
            return;
        }
        setReassignError(null);
        // Gate: if this save would push a notification-worthy change to a meeting with attendees,
        // intercept with the SendUpdatesDialog so the organizer can pick all vs. none. Cancel falls
        // back to the no-dialog path below.
        if (shouldInterceptForSendUpdates(trimmedTitle, trimmedNotes)) {
            setPendingSave({ trimmedTitle, trimmedNotes });
            return;
        }
        commitSave(trimmedTitle, trimmedNotes, undefined);
    }

    function commitSave(trimmedTitle: string, trimmedNotes: string, gcalMeta: { sendUpdates: 'all' | 'none' } | undefined) {
        const ownerChanged = ownerUserId !== item.userId;
        const statusChanged = status !== item.status;
        const path = decideSavePath(ownerChanged, statusChanged);
        startSaving(async () => {
            if (path.kind === 'statusTransition') {
                await saveViaStatusTransition(normalizeTitleAndNotes(item, trimmedTitle, trimmedNotes));
            } else {
                await saveInPlace(normalizeTitleAndNotes(item, trimmedTitle, trimmedNotes), gcalMeta);
            }
            await onSaved();
            onClose();
        });
    }

    /**
     * Decision: do we need to ask the organizer about emailing attendees before saving?
     * Only `inPlace` saves trigger the gate — status transitions and cross-account reassigns route
     * through different server paths that don't currently honour the sidecar.
     */
    function shouldInterceptForSendUpdates(trimmedTitle: string, trimmedNotes: string): boolean {
        if (status !== 'calendar') return false;
        const ownerChanged = ownerUserId !== item.userId;
        const statusChanged = status !== item.status;
        const path = decideSavePath(ownerChanged, statusChanged);
        if (path.kind !== 'saveInPlace') return false;
        const merged = mergeFormsIntoItem({ ...item, title: trimmedTitle, notes: trimmedNotes }, status, naForm, calForm, wfForm, visibleCalendarOptions);
        // Treat the live attendees state as the post-edit attendee set — attendee-editor changes
        // bypass Save (they queue their own ops) but a parallel title edit still needs the prompt.
        return shouldFireSendUpdatesDialog(
            {
                status: item.status,
                title: item.title,
                notes: item.notes,
                timeStart: item.timeStart,
                timeEnd: item.timeEnd,
                allDay: item.allDay,
                attendees: item.attendees,
            },
            {
                status,
                title: trimmedTitle,
                notes: trimmedNotes,
                timeStart: merged.timeStart,
                timeEnd: merged.timeEnd,
                allDay: merged.allDay,
                attendees: liveAttendees,
            },
        );
    }

    function validateReassign(): boolean {
        if (status !== 'calendar' || !item.calendarEventId) {
            return true;
        }
        const targetConfigId = calForm.calendarSyncConfigId;
        const targetOption = visibleCalendarOptions.find((opt) => opt.configId === targetConfigId);
        if (!targetOption || targetOption.userId !== ownerUserId) {
            setReassignError(`Pick a calendar from ${loggedInAccounts.find((a) => a.id === ownerUserId)?.email ?? 'the target account'} before saving.`);
            return false;
        }
        return true;
    }

    function startReassignInBackground(editPatch: ReassignItemEditPatch, label: string): void {
        const targetCalendar = resolveTargetCalendar();
        const hasEdits = Object.keys(editPatch).length > 0;
        runReassignWithOverlay({
            kind: 'item',
            entityId: item._id,
            label,
            override: {
                toUserId: ownerUserId,
                ...(targetCalendar ? { targetIntegrationId: targetCalendar.integrationId, targetSyncConfigId: targetCalendar.syncConfigId } : {}),
            },
            params: {
                entityType: 'item',
                entityId: item._id,
                fromUserId: item.userId,
                toUserId: ownerUserId,
                ...(targetCalendar ? { targetCalendar } : {}),
                ...(hasEdits ? { editPatch } : {}),
            },
        })
            .then(() => onSaved())
            .catch((err) => console.error('[reassign] post-flight refresh failed:', err));
    }

    function resolveTargetCalendar(): { integrationId: string; syncConfigId: string } | null {
        if (status !== 'calendar' || !item.calendarEventId) {
            return null;
        }
        const targetOption = visibleCalendarOptions.find((opt) => opt.configId === calForm.calendarSyncConfigId);
        if (!targetOption) {
            return null;
        }
        return { integrationId: targetOption.integrationId, syncConfigId: targetOption.configId };
    }

    async function saveInPlace(itemNormalized: StoredItem, gcalMeta: { sendUpdates: 'all' | 'none' } | undefined) {
        const merged = mergeFormsIntoItem(itemNormalized, status, naForm, calForm, wfForm, visibleCalendarOptions);
        // Fold in the live attendee state — it lives outside the form because the meeting-details
        // editor mutates it asynchronously and shouldn't be lost on Save.
        const withAttendees = liveAttendees && liveAttendees.length > 0 ? { ...merged, attendees: liveAttendees } : merged;
        if (gcalMeta) {
            await updateItemWithGcalMeta(db, withAttendees, gcalMeta);
        } else {
            await updateItem(db, withAttendees);
        }
        await maybeRecordRoutineException(withAttendees);
    }

    async function maybeRecordRoutineException(merged: StoredItem) {
        if (status !== 'calendar' || !merged.routineId || !item.timeStart) {
            return;
        }
        const timeChanged = merged.timeStart !== item.timeStart || merged.timeEnd !== item.timeEnd;
        const titleChanged = merged.title !== item.title;
        const notesChanged = (merged.notes ?? '') !== (item.notes ?? '');
        if (!timeChanged && !titleChanged && !notesChanged) {
            return;
        }
        const originalDate = dayjs(item.timeStart).format('YYYY-MM-DD');
        await recordRoutineInstanceModification(db, merged.routineId, originalDate, {
            itemId: merged._id,
            ...(timeChanged && merged.timeStart ? { newTimeStart: merged.timeStart } : {}),
            ...(timeChanged && merged.timeEnd ? { newTimeEnd: merged.timeEnd } : {}),
            ...(titleChanged ? { title: merged.title } : {}),
            ...(notesChanged ? { notes: merged.notes ?? '' } : {}),
        });
    }

    async function saveViaStatusTransition(itemNormalized: StoredItem) {
        const baseItem: StoredItem = shouldDetachFromRoutine(item.status, status, Boolean(item.routineId)) ? stripRoutineId(itemNormalized) : itemNormalized;
        switch (status) {
            case 'inbox':
                await clarifyToInbox(db, baseItem);
                break;
            case 'nextAction':
                await clarifyToNextAction(db, baseItem, buildNextActionMeta(naForm));
                break;
            case 'calendar':
                await clarifyToCalendar(db, baseItem, buildCalendarMeta(calForm, visibleCalendarOptions));
                break;
            case 'waitingFor':
                await clarifyToWaitingFor(db, baseItem, buildWaitingForMeta(wfForm));
                break;
            case 'somedayMaybe':
                await clarifyToSomedayMaybe(db, baseItem);
                break;
            case 'done':
                // `buildClarifyToDoneOpts` is a named helper so a refactor that drops the
                // prop-forwarding can't silently kill the fromGmail toast; see its doc comment.
                await clarifyToDone(db, baseItem, buildClarifyToDoneOpts(onFromGmailReadOnly));
                break;
            case 'trash':
                await clarifyToTrash(db, baseItem);
                break;
        }
    }

    /**
     * RSVP click handler — attempts the online path first so the user sees a fast organizer-side
     * notification when connected, then falls back to the offline replay queue for every other
     * outcome (network failure, generic 5xx, missing-scope). The optimistic UI flip happens
     * up-front so the chip color changes immediately regardless of which path resolves.
     */
    async function onRsvp(nextStatus: RsvpStatus) {
        const self = findSelfAttendee(liveAttendees ?? []);
        if (!self) {
            // The button only renders when a self attendee exists, but guard anyway — a race with an
            // inbound pull that strips the self attendee could surface a click without one.
            return;
        }
        const nextAttendees = applyOptimisticRsvp(liveAttendees ?? [], self.email, nextStatus);
        setLiveAttendees(nextAttendees);
        const result = await rsvpOnline(item._id, nextStatus as RsvpPushStatus);
        if (result.ok) {
            setScopeMissingReconsentUrl(null);
            // Server-confirmed RSVP — adopt its attendees array verbatim so any concurrent organizer
            // changes (added attendees, etc.) land locally. updatedTs comes from the server too.
            if (result.item.attendees) setLiveAttendees(result.item.attendees);
            await onSaved();
            return;
        }
        if (result.scopeMissing) {
            setScopeMissingReconsentUrl(result.reconsentUrl);
            return;
        }
        // Generic failure (network or other 5xx) — queue an offline rsvp op so the replay path
        // resolves it on next flush. Only enqueue when the item carries enough GCal context.
        if (item.calendarEventId && item.calendarIntegrationId) {
            await queueOfflineRsvp(db, item, {
                responseStatus: nextStatus,
                calendarEventId: item.calendarEventId,
                calendarIntegrationId: item.calendarIntegrationId,
                attendees: nextAttendees,
            });
            await onSaved();
        }
    }

    /**
     * Attendees-editor handler. Persist immediately so the change shows up on every device — the
     * server-side pushback turns this into an events.patch with GCal-default notifications. We
     * deliberately do not surface a SendUpdatesDialog here: attendee additions/removals always
     * notify the affected party on GCal's side regardless of organizer preference.
     */
    async function onAttendeesChange(next: GCalAttendee[]) {
        setLiveAttendees(next);
        await updateItemAttendees(db, item, next);
        await onSaved();
    }

    if (reassignInFlight) {
        // Dialog wrapper short-circuits to ReassignInFlightDialog before mounting the body, so this
        // branch only fires under popover/expand/page.
        return (
            <Box className={bodyClassFor(chrome)}>
                <ReassignInFlightInline onClose={onClose} />
            </Box>
        );
    }

    const shouldAutoFocus = shouldAutoFocusTitle(chrome, initialStatus);

    return (
        <Box className={bodyClassFor(chrome)}>
            <TextField
                label="Title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                fullWidth
                required
                {...(shouldAutoFocus ? { autoFocus: true } : {})}
            />

            <NotesSection notes={notes} onNotesChange={setNotes} chrome={chrome} />

            <Divider />

            <Box>
                <Typography
                    variant="caption"
                    className={styles.statusLabel}
                    sx={{
                        color: 'text.secondary',
                        fontWeight: 600,
                    }}
                >
                    Status
                </Typography>
                <Stack
                    direction="row"
                    className={styles.statusChips}
                    sx={{
                        flexWrap: 'wrap',
                        gap: 1,
                    }}
                >
                    {STATUS_CHIPS.map((cfg) => (
                        <Chip
                            key={cfg.value}
                            icon={cfg.icon}
                            label={cfg.label}
                            variant={status === cfg.value ? 'filled' : 'outlined'}
                            color={status === cfg.value ? (cfg.color ?? 'primary') : 'default'}
                            onClick={() => setStatus(cfg.value)}
                        />
                    ))}
                </Stack>
            </Box>

            {loggedInAccounts.length > 1 && (
                <Box>
                    <AccountPicker
                        value={ownerUserId}
                        onChange={(uid) => {
                            setOwnerUserId(uid);
                            setReassignError(null);
                            setCalForm((f) => ({ ...f, calendarSyncConfigId: pickDefaultConfigForUser(calendarOptions, uid, item) }));
                        }}
                        disabled={isRoutineGenerated || isSaving}
                        {...(reassignError ? { error: reassignError } : {})}
                    />
                    {isRoutineGenerated && (
                        <Typography
                            variant="caption"
                            sx={{
                                color: 'text.secondary',
                                mt: 0.5,
                                display: 'block',
                            }}
                        >
                            To move this, edit the routine itself.
                        </Typography>
                    )}
                </Box>
            )}

            {status === 'nextAction' && (
                <>
                    <Divider />
                    <NextActionFields value={naForm} onChange={(patch) => setNaForm((f) => ({ ...f, ...patch }))} workContexts={workContexts} people={people} />
                </>
            )}

            {status === 'calendar' && (
                <>
                    <Divider />
                    <CalendarFields
                        value={calForm}
                        onChange={(patch) => setCalForm((f) => applyCalendarPatch(f, patch))}
                        calendarOptions={visibleCalendarOptions}
                        forceShowPicker={ownerUserId !== item.userId}
                    />
                    {((liveAttendees?.length ?? 0) > 0 || item.organizer) && (
                        <MeetingDetails
                            item={{ ...item, ...(liveAttendees ? { attendees: liveAttendees } : {}) }}
                            db={db}
                            ownerUserIdForNewPeople={ownerUserId}
                            onRsvp={onRsvp}
                            onAttendeesChange={onAttendeesChange}
                            {...(scopeMissingReconsentUrl ? { scopeMissingReconsentUrl } : {})}
                            onReconsentClosed={() => setScopeMissingReconsentUrl(null)}
                        />
                    )}
                </>
            )}

            {status === 'waitingFor' && (
                <>
                    <Divider />
                    <WaitingForFields value={wfForm} onChange={(patch) => setWfForm((f) => ({ ...f, ...patch }))} people={people} />
                </>
            )}

            {status === 'somedayMaybe' && (
                <Box className={styles.somedayEmpty}>
                    <Typography variant="body2">Parked for later review. No schedule or context — just title and notes.</Typography>
                </Box>
            )}

            {renderActions ? (
                chrome === 'dialog' ? (
                    <DialogActions sx={{ px: 0 }}>{renderActions({ triggerSave: onSave, saveDisabled, isSaving, onClose })}</DialogActions>
                ) : (
                    <Box className={styles.inlineActions}>{renderActions({ triggerSave: onSave, saveDisabled, isSaving, onClose })}</Box>
                )
            ) : chrome === 'dialog' ? (
                <DialogActions sx={{ px: 0 }}>
                    <Button onClick={onClose}>Cancel</Button>
                    <Button variant="contained" disabled={saveDisabled} onClick={() => onSave()}>
                        Save changes
                    </Button>
                </DialogActions>
            ) : (
                <Box className={styles.inlineActions}>
                    <Button onClick={onClose}>Cancel</Button>
                    <Button variant="contained" disabled={saveDisabled} onClick={() => onSave()}>
                        Save changes
                    </Button>
                </Box>
            )}
            <SendUpdatesDialog
                open={pendingSave !== null}
                attendeeCount={liveAttendees?.length ?? 0}
                onConfirm={(sendUpdates) => {
                    if (!pendingSave) return;
                    const { trimmedTitle, trimmedNotes } = pendingSave;
                    setPendingSave(null);
                    commitSave(trimmedTitle, trimmedNotes, { sendUpdates });
                }}
                onCancel={() => setPendingSave(null)}
            />
        </Box>
    );
}
