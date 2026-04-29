import CalendarTodayIcon from '@mui/icons-material/CalendarToday';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import LightbulbOutlinedIcon from '@mui/icons-material/LightbulbOutlined';
import MoveToInboxIcon from '@mui/icons-material/MoveToInbox';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
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
import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { useAppData } from '../contexts/AppDataProvider';
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
import { reassignEntity } from '../db/reassignMutations';
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
    type EditableStatus,
    isSaveDisabled,
    mergeFormsIntoItem,
    normalizeTitleAndNotes,
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
    const [title, setTitle] = useState(item.title);
    const [notes, setNotes] = useState(item.notes ?? '');
    const [notesTab, setNotesTab] = useState<0 | 1>(0);
    const [status, setStatus] = useState<EditableStatus>(item.status);
    // Owner of the item — when changed and saved, triggers `/sync/reassign`. Defaults to the
    // current owner so single-account devices and unchanged saves are no-ops on the reassign path.
    const [ownerUserId, setOwnerUserId] = useState(item.userId);
    // Reassign error surfaced inline (e.g. "select a target calendar before saving").
    const [reassignError, setReassignError] = useState<string | null>(null);
    // Re-entry guard — rapid double-clicks on Save must not fire two mutations.
    const [isSaving, setIsSaving] = useState(false);
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

    async function onSave() {
        if (isSaving) {
            return;
        }
        const trimmedTitle = title.trim();
        if (!trimmedTitle) {
            return;
        }
        const ownerChanged = ownerUserId !== item.userId;
        if (ownerChanged && !validateReassign()) {
            return;
        }
        setIsSaving(true);
        setReassignError(null);
        try {
            const itemNormalized = normalizeTitleAndNotes(item, trimmedTitle, notes.trim());
            const statusChanged = status !== item.status;
            if (statusChanged) {
                await saveViaStatusTransition(itemNormalized);
            } else {
                await saveInPlace(itemNormalized);
            }
            // Reassignment runs last so the in-place edits land on the source-user copy first;
            // the server then moves that updated entity across to the new owner. Doing it in the
            // other order would mean the source delete races against the local update.
            if (ownerChanged) {
                const reassignOk = await runReassign();
                if (!reassignOk) {
                    return; // error already set via setReassignError; keep dialog open for retry
                }
            }
            await onSaved();
            onClose();
        } finally {
            setIsSaving(false);
        }
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
     * Calls `/sync/reassign`. The target calendar is required for calendar-linked items —
     * `validateReassign` already enforced presence; here we look up the option and forward
     * its integration + sync config ids to the server.
     */
    async function runReassign(): Promise<boolean> {
        const targetCalendar = resolveTargetCalendar();
        const result = await reassignEntity(db, {
            entityType: 'item',
            entityId: item._id,
            fromUserId: item.userId,
            toUserId: ownerUserId,
            ...(targetCalendar ? { targetCalendar } : {}),
        });
        if (!result.ok) {
            setReassignError(result.error);
            return false;
        }
        return true;
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
                    <Typography variant="caption" color="text.secondary" fontWeight={600} className={styles.statusLabel}>
                        Status
                    </Typography>
                    <Stack direction="row" flexWrap="wrap" gap={1} className={styles.statusChips}>
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
                            }}
                            disabled={isRoutineGenerated || isSaving}
                            {...(reassignError ? { error: reassignError } : {})}
                        />
                        {isRoutineGenerated && (
                            <Typography variant="caption" color="text.secondary" mt={0.5} display="block">
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
