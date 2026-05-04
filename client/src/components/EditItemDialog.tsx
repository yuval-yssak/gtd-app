import CalendarTodayIcon from '@mui/icons-material/CalendarToday';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import LightbulbOutlinedIcon from '@mui/icons-material/LightbulbOutlined';
import MoveToInboxIcon from '@mui/icons-material/MoveToInbox';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { useMemo, useState, useTransition } from 'react';
import ReactMarkdown from 'react-markdown';
import type { ReassignItemEditPatch } from '../api/syncApi';
import { useAppData } from '../contexts/AppDataProvider';
import { usePendingReassign } from '../contexts/PendingReassignProvider';
import {
    clarifyToCalendar,
    clarifyToDone,
    clarifyToInbox,
    clarifyToNextAction,
    clarifyToSomedayMaybe,
    clarifyToTrash,
    clarifyToWaitingFor,
    recordRoutineInstanceModification,
    updateItem,
} from '../db/itemMutations';
import { useCalendarOptions } from '../hooks/useCalendarOptions';
import type { MyDB, StoredItem, StoredPerson, StoredWorkContext } from '../types/MyDB';
import { AccountPicker } from './AccountPicker';
import { CalendarFields } from './clarify/CalendarFields';
import { NextActionFields } from './clarify/NextActionFields';
import {
    buildCalendarMeta,
    buildNextActionMeta,
    buildWaitingForMeta,
    type CalendarFormState,
    emptyCalendar,
    type NextActionFormState,
    type WaitingForFormState,
} from './clarify/types';
import { WaitingForFields } from './clarify/WaitingForFields';
import styles from './EditItemDialog.module.css';
import {
    applyCalendarPatch,
    buildEditPatch,
    decideSavePath,
    type EditableStatus,
    isSaveDisabled,
    mergeFormsIntoItem,
    normalizeTitleAndNotes,
    pickDefaultConfigForUser,
    shouldDetachFromRoutine,
    stripRoutineId,
} from './editItemDialogLogic';

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

interface Props {
    item: StoredItem;
    db: IDBPDatabase<MyDB>;
    people: StoredPerson[];
    workContexts: StoredWorkContext[];
    onClose: () => void;
    onSaved: () => Promise<void>;
}

/** Converts a calendar item's timeStart/timeEnd into the CalendarFormState shape. */
function itemToCalendarForm(item: StoredItem): CalendarFormState {
    if (!item.timeStart) {
        return emptyCalendar;
    }
    const start = dayjs(item.timeStart);
    const end = item.timeEnd ? dayjs(item.timeEnd) : start.add(1, 'hour');
    return {
        date: start.format('YYYY-MM-DD'),
        startTime: start.format('HH:mm'),
        endTime: end.format('HH:mm'),
        calendarSyncConfigId: item.calendarSyncConfigId ?? '',
    };
}

export function EditItemDialog({ item, db, people, workContexts, onClose, onSaved }: Props) {
    const { options: calendarOptions } = useCalendarOptions();
    const { loggedInAccounts } = useAppData();
    const { runReassignWithOverlay, isPending } = usePendingReassign();
    // While a cross-account reassign is in flight, the AppDataProvider rewrites the rendered
    // item's userId to the target — opening the edit dialog on the overlayed row would seed
    // ownerUserId from the wrong owner, and a save under that state could write IDB under the
    // target user (the exact misroute bug the existing reassign flow was designed to prevent).
    // Refuse to render the form until the move resolves. The guard is read here but the early
    // return happens after all hooks (rules-of-hooks).
    const reassignInFlight = isPending('item', item._id);
    const [title, setTitle] = useState(item.title);
    const [notes, setNotes] = useState(item.notes ?? '');
    const [notesTab, setNotesTab] = useState<0 | 1>(0);
    const [status, setStatus] = useState<EditableStatus>(item.status);
    // Owner of the item — when changed and saved, triggers `/sync/reassign`. Defaults to the
    // current owner so single-account devices and unchanged saves are no-ops on the reassign path.
    const [ownerUserId, setOwnerUserId] = useState(item.userId);
    // Reassign error surfaced inline (e.g. "select a target calendar before saving").
    const [reassignError, setReassignError] = useState<string | null>(null);
    // Re-entry guard — rapid double-clicks on Save must not fire two mutations. useTransition does
    // not dedupe successive startTransition calls, so the `isSaving` short-circuit at the top of
    // onSave (and `saveDisabled` on the Save button) is what actually blocks double-submits.
    const [isSaving, startSaving] = useTransition();
    // Routine-generated items can't be reassigned — disable the picker and show a hint instead.
    const isRoutineGenerated = Boolean(item.routineId);

    // Pre-populate each status's form from the current item so edits are incremental.
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
    // When the owner is the entity's current user, show every calendar option so the user can
    // re-pick within their account. When reassigning, restrict to the target account's calendars
    // only — picking a calendar from the source account would silently drop the cross-account move
    // because /sync/reassign rejects items linked to a different user's calendar.
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
            // Optimistic UX: register the presentational overlay so the item appears under the
            // target account immediately, close the dialog, and let the server round-trip run
            // in the background. PendingReassignProvider clears the overlay on success and
            // surfaces a revert snackbar on failure — we don't await here.
            startReassignInBackground(buildEditPatch(item, trimmedTitle, notes.trim(), status, naForm, calForm, wfForm), trimmedTitle);
            onClose();
            return;
        }
        setReassignError(null);
        startSaving(async () => {
            if (path.kind === 'statusTransition') {
                await saveViaStatusTransition(normalizeTitleAndNotes(item, trimmedTitle, notes.trim()));
            } else {
                await saveInPlace(normalizeTitleAndNotes(item, trimmedTitle, notes.trim()));
            }
            await onSaved();
            onClose();
        });
    }

    /**
     * Pre-flight checks for the reassign path. Returns false (and sets `reassignError`) when the
     * user picked a different owner but didn't pick a target calendar for a calendar-linked item.
     * Routine-generated items are blocked in the picker itself, so they can't reach this point.
     */
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

    /**
     * Registers the presentational overlay and fires `/sync/reassign` in the background. The
     * dialog is closed by the caller before this promise resolves — `runReassignWithOverlay`
     * takes ownership of the failure UX (snackbar revert) so we don't need to keep the dialog
     * open for retry. The optional `editPatch` carries the dialog's field edits so the server
     * applies them atomically with the move (no source-user pre-write).
     */
    function startReassignInBackground(editPatch: ReassignItemEditPatch, label: string): void {
        const targetCalendar = resolveTargetCalendar();
        const hasEdits = Object.keys(editPatch).length > 0;
        // onSaved() here is a redundant safety net — `reassignEntity` already calls
        // syncAllLoggedInUsers which refreshes AppDataProvider state — but kept so routes that
        // override onSaved with non-refresh side effects still see "completed".
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

    /** Status unchanged: merge form state into the item directly and persist via updateItem. */
    async function saveInPlace(itemNormalized: StoredItem) {
        // visibleCalendarOptions narrows to the target account when reassigning — the merged item
        // then carries the target account's integration/syncConfig ids without an extra branch.
        const merged = mergeFormsIntoItem(itemNormalized, status, naForm, calForm, wfForm, visibleCalendarOptions);
        await updateItem(db, merged);
        await maybeRecordRoutineException(merged);
    }

    /**
     * For routine-generated calendar items, record a `modified` exception when title, notes, or
     * time changed. This lets the routine remember the override so future regeneration/splits
     * respect the user's per-instance edit. Matches matrix A2/A3 expectations.
     */
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
        // `originalDate` is the routine occurrence's date — derived from the pre-edit timeStart.
        const originalDate = dayjs(item.timeStart).format('YYYY-MM-DD');
        await recordRoutineInstanceModification(db, merged.routineId, originalDate, {
            itemId: merged._id,
            ...(timeChanged && merged.timeStart ? { newTimeStart: merged.timeStart } : {}),
            ...(timeChanged && merged.timeEnd ? { newTimeEnd: merged.timeEnd } : {}),
            ...(titleChanged ? { title: merged.title } : {}),
            ...(notesChanged ? { notes: merged.notes ?? '' } : {}),
        });
    }

    /** Status changed: route through the appropriate clarify helper so stale fields are stripped. */
    async function saveViaStatusTransition(itemNormalized: StoredItem) {
        // Detach from the routine only when moving into another live in-list status.
        // Done and trash must keep routineId so the disposal path records a skipped exception
        // or advances the series — see shouldDetachFromRoutine for the full rule.
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
                await clarifyToDone(db, baseItem);
                break;
            case 'trash':
                await clarifyToTrash(db, baseItem);
                break;
        }
    }

    if (reassignInFlight) {
        return <ReassignInFlightDialog onClose={onClose} />;
    }

    return (
        <Dialog open onClose={onClose} fullWidth maxWidth="sm">
            <DialogTitle>Edit item</DialogTitle>
            <DialogContent className={styles.dialogContent}>
                <TextField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} fullWidth required autoFocus />

                <Box>
                    <Tabs value={notesTab} onChange={(_, v) => setNotesTab(v as 0 | 1)} className={styles.tabs}>
                        <Tab label="Edit" value={0} />
                        <Tab label="Preview" value={1} />
                    </Tabs>
                    {notesTab === 0 ? (
                        <TextField
                            label="Notes (Markdown)"
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            fullWidth
                            multiline
                            rows={4}
                            placeholder="Supports **bold**, _italic_, `code`, lists, etc."
                        />
                    ) : (
                        <Box className={styles.preview}>
                            {notes.trim() ? <ReactMarkdown>{notes}</ReactMarkdown> : <span className={styles.empty}>Nothing to preview.</span>}
                        </Box>
                    )}
                </Box>

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

                {/* Hidden on single-account devices via the picker's own short-circuit. */}
                {loggedInAccounts.length > 1 && (
                    <Box>
                        <AccountPicker
                            value={ownerUserId}
                            onChange={(uid) => {
                                setOwnerUserId(uid);
                                setReassignError(null);
                                // The previously-picked calendar belongs to the old owner and is filtered out of
                                // visibleCalendarOptions for the new owner — leaving it would render the Select as empty
                                // (looks like nothing is picked) and fail validateReassign on save. Pre-pick the target's
                                // default (or sole calendar) so the user only has to confirm.
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
                        <NextActionFields
                            value={naForm}
                            onChange={(patch) => setNaForm((f) => ({ ...f, ...patch }))}
                            workContexts={workContexts}
                            people={people}
                        />
                    </>
                )}

                {status === 'calendar' && (
                    <>
                        <Divider />
                        <CalendarFields
                            value={calForm}
                            onChange={(patch) => setCalForm((f) => applyCalendarPatch(f, patch))}
                            calendarOptions={visibleCalendarOptions}
                            // Reassign requires an explicit pick (validateReassign), so show the picker
                            // even if the target account only has one calendar.
                            forceShowPicker={ownerUserId !== item.userId}
                        />
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
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose}>Cancel</Button>
                <Button variant="contained" disabled={saveDisabled} onClick={() => void onSave()}>
                    Save changes
                </Button>
            </DialogActions>
        </Dialog>
    );
}

/**
 * Shown when the edit dialog is opened on an entity with an in-flight cross-account reassign.
 * Editing under that state would seed `ownerUserId` from the overlayed (target) user and a save
 * would write IDB under the target — the precise misroute the reassign flow exists to prevent.
 */
function ReassignInFlightDialog({ onClose }: { onClose: () => void }) {
    return (
        <Dialog open onClose={onClose} fullWidth maxWidth="xs">
            <DialogTitle>Move in progress</DialogTitle>
            <DialogContent>
                <Alert severity="info" variant="outlined">
                    This item is being moved to another account. You can edit it once the move completes.
                </Alert>
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose}>Close</Button>
            </DialogActions>
        </Dialog>
    );
}
