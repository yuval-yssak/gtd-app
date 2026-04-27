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
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
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
    const [title, setTitle] = useState(item.title);
    const [notes, setNotes] = useState(item.notes ?? '');
    const [notesTab, setNotesTab] = useState<0 | 1>(0);
    const [status, setStatus] = useState<EditableStatus>(item.status);
    // Re-entry guard — rapid double-clicks on Save must not fire two mutations.
    const [isSaving, setIsSaving] = useState(false);

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
        setIsSaving(true);
        try {
            const itemNormalized = normalizeTitleAndNotes(item, trimmedTitle, notes.trim());
            const statusChanged = status !== item.status;
            if (statusChanged) {
                await saveViaStatusTransition(itemNormalized);
            } else {
                await saveInPlace(itemNormalized);
            }
            await onSaved();
            onClose();
        } finally {
            setIsSaving(false);
        }
    }

    /** Status unchanged: merge form state into the item directly and persist via updateItem. */
    async function saveInPlace(itemNormalized: StoredItem) {
        const merged = mergeFormsIntoItem(itemNormalized, status, naForm, calForm, wfForm, calendarOptions);
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
                await clarifyToCalendar(db, baseItem, buildCalendarMeta(calForm, calendarOptions));
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
                            calendarOptions={calendarOptions}
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
