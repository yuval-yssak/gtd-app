import CalendarTodayIcon from '@mui/icons-material/CalendarToday';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import MoveToInboxIcon from '@mui/icons-material/MoveToInbox';
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
import type { IDBPDatabase } from 'idb';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { clarifyToCalendar, clarifyToDone, clarifyToInbox, clarifyToTrash, clarifyToWaitingFor, updateItem } from '../db/itemMutations';
import type { EnergyLevel, MyDB, StoredItem, StoredPerson, StoredWorkContext } from '../types/MyDB';
import { CalendarFields } from './clarify/CalendarFields';
import { NextActionFields } from './clarify/NextActionFields';
import {
    buildCalendarTimes,
    buildWaitingForMeta,
    type CalendarFormState,
    emptyCalendar,
    emptyWaitingFor,
    type NextActionFormState,
    type WaitingForFormState,
} from './clarify/types';
import { WaitingForFields } from './clarify/WaitingForFields';
import styles from './EditNextActionDialog.module.css';

type MoveDest = 'calendar' | 'waitingFor';

interface Props {
    item: StoredItem;
    db: IDBPDatabase<MyDB>;
    people: StoredPerson[];
    workContexts: StoredWorkContext[];
    onClose: () => void;
    onSaved: () => Promise<void>;
}

export function EditNextActionDialog({ item, db, people, workContexts, onClose, onSaved }: Props) {
    const [title, setTitle] = useState(item.title);
    const [notes, setNotes] = useState(item.notes ?? '');
    const [notesTab, setNotesTab] = useState<0 | 1>(0);

    // Pre-populate form fields from the existing item so edits are incremental, not full rewrites
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

    const [moveDest, setMoveDest] = useState<MoveDest | null>(null);
    const [calForm, setCalForm] = useState<CalendarFormState>(emptyCalendar);
    const [wfForm, setWfForm] = useState<WaitingForFormState>(emptyWaitingFor);

    async function onSave() {
        const trimmedTitle = title.trim();
        if (!trimmedTitle) return;
        const trimmedNotes = notes.trim();

        // Destructure out all mutable optional fields so we can re-set them cleanly.
        // This avoids stale values persisting when the user clears a field (e.g. removes all contexts).
        const {
            notes: _n,
            workContextIds: _wc,
            peopleIds: _pi,
            energy: _e,
            time: _t,
            urgent: _u,
            focus: _f,
            expectedBy: _eb,
            ignoreBefore: _ib,
            ...rest
        } = item;
        const updated: StoredItem = {
            ...rest,
            title: trimmedTitle,
            ...(trimmedNotes ? { notes: trimmedNotes } : {}),
            ...(naForm.workContextIds.length ? { workContextIds: naForm.workContextIds } : {}),
            ...(naForm.peopleIds.length ? { peopleIds: naForm.peopleIds } : {}),
            ...(naForm.energy ? { energy: naForm.energy as EnergyLevel } : {}),
            ...(naForm.time ? { time: Number(naForm.time) } : {}),
            ...(naForm.urgent ? { urgent: true } : {}),
            ...(naForm.focus ? { focus: true } : {}),
            ...(naForm.expectedBy ? { expectedBy: naForm.expectedBy } : {}),
            ...(naForm.ignoreBefore ? { ignoreBefore: naForm.ignoreBefore } : {}),
        };
        await updateItem(db, updated);
        await onSaved();
        onClose();
    }

    async function onMoveInstant(mutation: (db: IDBPDatabase<MyDB>, item: StoredItem) => Promise<StoredItem>) {
        await mutation(db, item);
        await onSaved();
        onClose();
    }

    async function onConfirmCalendar() {
        const { startIso, endIso } = buildCalendarTimes(calForm);
        await clarifyToCalendar(db, item, startIso, endIso);
        await onSaved();
        onClose();
    }

    async function onConfirmWaitingFor() {
        await clarifyToWaitingFor(db, item, buildWaitingForMeta(wfForm));
        await onSaved();
        onClose();
    }

    function onMoveChipClick(dest: MoveDest) {
        // Toggle the sub-form: clicking the same chip again collapses it
        setMoveDest((prev) => (prev === dest ? null : dest));
    }

    return (
        <Dialog open onClose={onClose} fullWidth maxWidth="sm">
            <DialogTitle>Edit next action</DialogTitle>
            <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '16px !important' }}>
                <TextField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} fullWidth required autoFocus />

                <div>
                    <Tabs value={notesTab} onChange={(_, v) => setNotesTab(v as 0 | 1)} sx={{ mb: 1 }}>
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
                        <div className={styles['preview']}>
                            {notes.trim() ? <ReactMarkdown>{notes}</ReactMarkdown> : <span className={styles['empty']}>Nothing to preview.</span>}
                        </div>
                    )}
                </div>

                <Divider />

                <NextActionFields value={naForm} onChange={(patch) => setNaForm((f) => ({ ...f, ...patch }))} workContexts={workContexts} people={people} />

                <Divider />

                <Box>
                    <Typography variant="caption" color="text.secondary" fontWeight={600} sx={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>
                        Move to
                    </Typography>
                    <Stack direction="row" flexWrap="wrap" gap={1} mt={1}>
                        <Chip icon={<MoveToInboxIcon />} label="Inbox" variant="outlined" onClick={() => void onMoveInstant(clarifyToInbox)} />
                        <Chip
                            icon={<CalendarTodayIcon />}
                            label="Calendar"
                            variant={moveDest === 'calendar' ? 'filled' : 'outlined'}
                            color={moveDest === 'calendar' ? 'primary' : 'default'}
                            onClick={() => onMoveChipClick('calendar')}
                        />
                        <Chip
                            icon={<HourglassEmptyIcon />}
                            label="Waiting For"
                            variant={moveDest === 'waitingFor' ? 'filled' : 'outlined'}
                            color={moveDest === 'waitingFor' ? 'primary' : 'default'}
                            onClick={() => onMoveChipClick('waitingFor')}
                        />
                        <Chip
                            icon={<CheckCircleOutlineIcon />}
                            label="Done"
                            variant="outlined"
                            color="success"
                            onClick={() => void onMoveInstant(clarifyToDone)}
                        />
                        <Chip icon={<DeleteOutlineIcon />} label="Trash" variant="outlined" color="error" onClick={() => void onMoveInstant(clarifyToTrash)} />
                    </Stack>

                    {moveDest === 'calendar' && (
                        <Box sx={{ mt: 2 }}>
                            <CalendarFields value={calForm} onChange={(patch) => setCalForm((f) => ({ ...f, ...patch }))} />
                            <Stack direction="row" gap={1} mt={1.5}>
                                <Button size="small" onClick={() => setMoveDest(null)}>
                                    Cancel
                                </Button>
                                <Button size="small" variant="contained" disabled={!calForm.date} onClick={() => void onConfirmCalendar()}>
                                    Confirm move to Calendar
                                </Button>
                            </Stack>
                        </Box>
                    )}

                    {moveDest === 'waitingFor' && (
                        <Box sx={{ mt: 2 }}>
                            <WaitingForFields value={wfForm} onChange={(patch) => setWfForm((f) => ({ ...f, ...patch }))} people={people} />
                            <Stack direction="row" gap={1} mt={1.5}>
                                <Button size="small" onClick={() => setMoveDest(null)}>
                                    Cancel
                                </Button>
                                <Button size="small" variant="contained" disabled={!wfForm.waitingForPersonId} onClick={() => void onConfirmWaitingFor()}>
                                    Confirm move to Waiting For
                                </Button>
                            </Stack>
                        </Box>
                    )}
                </Box>
            </DialogContent>

            <DialogActions>
                <Button onClick={onClose}>Cancel</Button>
                <Button variant="contained" disabled={!title.trim()} onClick={() => void onSave()}>
                    Save changes
                </Button>
            </DialogActions>
        </Dialog>
    );
}
