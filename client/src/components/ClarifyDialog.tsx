import AssignmentTurnedInIcon from '@mui/icons-material/AssignmentTurnedIn';
import BoltIcon from '@mui/icons-material/Bolt';
import CalendarTodayIcon from '@mui/icons-material/CalendarToday';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormLabel from '@mui/material/FormLabel';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { IDBPDatabase } from 'idb';
import { useState } from 'react';
import { clarifyToCalendar, clarifyToDone, clarifyToNextAction, clarifyToTrash, clarifyToWaitingFor } from '../db/itemMutations';
import type { MyDB, StoredItem, StoredPerson, StoredWorkContext } from '../types/MyDB';
import styles from './ClarifyDialog.module.css';
import { CalendarFields } from './clarify/CalendarFields';
import { NextActionFields } from './clarify/NextActionFields';
import {
    buildCalendarTimes,
    buildNextActionMeta,
    buildWaitingForMeta,
    type CalendarFormState,
    type Destination,
    emptyCalendar,
    emptyNextAction,
    emptyWaitingFor,
    type NextActionFormState,
    type WaitingForFormState,
} from './clarify/types';
import { WaitingForFields } from './clarify/WaitingForFields';

interface Props {
    items: StoredItem[];
    db: IDBPDatabase<MyDB>;
    people: StoredPerson[];
    workContexts: StoredWorkContext[];
    onClose: () => void;
    onItemProcessed: () => Promise<void>;
    // Pre-selects a destination chip on open — used when opening for a single item from inline buttons
    initialDestination?: Destination;
}

export function ClarifyDialog({ items, db, people, workContexts, onClose, onItemProcessed, initialDestination }: Props) {
    const [index, setIndex] = useState(0);
    const [destination, setDestination] = useState<Destination | null>(initialDestination ?? null);
    const [nextActionForm, setNextActionForm] = useState<NextActionFormState>(emptyNextAction);
    const [calendarForm, setCalendarForm] = useState<CalendarFormState>(emptyCalendar);
    const [waitingForForm, setWaitingForForm] = useState<WaitingForFormState>(emptyWaitingFor);
    const [done, setDone] = useState(false);

    const currentItem = items[index];
    const total = items.length;
    // Single-item mode: opened from an inline button — hide progress counter and Skip
    const isSingleItem = total === 1;

    function resetForms() {
        setDestination(null);
        setNextActionForm(emptyNextAction);
        setCalendarForm(emptyCalendar);
        setWaitingForForm(emptyWaitingFor);
    }

    function advanceOrFinish() {
        if (index + 1 >= total) {
            setDone(true);
        } else {
            setIndex((i) => i + 1);
            resetForms();
        }
    }

    async function onConfirm() {
        if (!currentItem || !destination) return;
        await processItem(currentItem, destination);
        await onItemProcessed();
        advanceOrFinish();
    }

    async function onSkip() {
        advanceOrFinish();
    }

    async function processItem(item: StoredItem, dest: Destination) {
        if (dest === 'done') {
            await clarifyToDone(db, item);
            return;
        }
        if (dest === 'trash') {
            await clarifyToTrash(db, item);
            return;
        }
        if (dest === 'nextAction') {
            await clarifyToNextAction(db, item, buildNextActionMeta(nextActionForm));
            return;
        }
        if (dest === 'calendar') {
            const { startIso, endIso } = buildCalendarTimes(calendarForm);
            await clarifyToCalendar(db, item, startIso, endIso);
            return;
        }
        if (dest === 'waitingFor') {
            await clarifyToWaitingFor(db, item, buildWaitingForMeta(waitingForForm));
        }
    }

    function isConfirmDisabled(): boolean {
        if (!destination) return true;
        if (destination === 'calendar' && !calendarForm.date) return true;
        if (destination === 'waitingFor' && !waitingForForm.waitingForPersonId) return true;
        return false;
    }

    if (done) {
        return (
            <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
                <DialogContent className={styles.completedContent}>
                    <AssignmentTurnedInIcon className={styles.completedIcon} />
                    <Typography variant="h6" fontWeight={600}>
                        Inbox clear!
                    </Typography>
                    <Typography variant="body2" color="text.secondary" mt={1}>
                        All {total} item{total !== 1 ? 's' : ''} processed.
                    </Typography>
                </DialogContent>
                <DialogActions className={styles.completedActions}>
                    <Button variant="contained" onClick={onClose}>
                        Done
                    </Button>
                </DialogActions>
            </Dialog>
        );
    }

    return (
        <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
            <DialogTitle className={styles.dialogTitle}>
                {/* component="span" prevents an h6 nested inside DialogTitle's h2, which is invalid HTML */}
                <Typography component="span" variant="subtitle1" fontWeight={600}>
                    Clarify
                </Typography>
                {/* Counter only meaningful in batch mode */}
                {!isSingleItem && (
                    <Typography component="span" variant="caption" color="text.secondary">
                        {index + 1} of {total}
                    </Typography>
                )}
            </DialogTitle>

            <DialogContent dividers>
                <Typography variant="h6" fontWeight={500} mb={3}>
                    "{currentItem?.title}"
                </Typography>

                <FormLabel className={styles.formLabel}>
                    <Typography variant="caption" color="text.secondary" fontWeight={600} className={styles.sectionLabel}>
                        What is it?
                    </Typography>
                </FormLabel>
                <Stack direction="row" flexWrap="wrap" gap={1} mb={3}>
                    <Chip
                        icon={<DeleteOutlineIcon />}
                        label="Trash"
                        onClick={() => setDestination('trash')}
                        color={destination === 'trash' ? 'error' : 'default'}
                        variant={destination === 'trash' ? 'filled' : 'outlined'}
                    />
                    <Chip
                        icon={<AssignmentTurnedInIcon />}
                        label="Done < 2 min"
                        onClick={() => setDestination('done')}
                        color={destination === 'done' ? 'success' : 'default'}
                        variant={destination === 'done' ? 'filled' : 'outlined'}
                    />
                    <Chip
                        icon={<BoltIcon />}
                        label="Next Action"
                        onClick={() => setDestination('nextAction')}
                        color={destination === 'nextAction' ? 'primary' : 'default'}
                        variant={destination === 'nextAction' ? 'filled' : 'outlined'}
                    />
                    <Chip
                        icon={<CalendarTodayIcon />}
                        label="Calendar"
                        onClick={() => setDestination('calendar')}
                        color={destination === 'calendar' ? 'primary' : 'default'}
                        variant={destination === 'calendar' ? 'filled' : 'outlined'}
                    />
                    <Chip
                        icon={<HourglassEmptyIcon />}
                        label="Waiting For"
                        onClick={() => setDestination('waitingFor')}
                        color={destination === 'waitingFor' ? 'primary' : 'default'}
                        variant={destination === 'waitingFor' ? 'filled' : 'outlined'}
                    />
                </Stack>

                {destination === 'nextAction' && (
                    <Box className={styles.form}>
                        <NextActionFields
                            value={nextActionForm}
                            onChange={(patch) => setNextActionForm((f) => ({ ...f, ...patch }))}
                            workContexts={workContexts}
                            people={people}
                        />
                    </Box>
                )}

                {destination === 'calendar' && (
                    <Box className={styles.form}>
                        <CalendarFields value={calendarForm} onChange={(patch) => setCalendarForm((f) => ({ ...f, ...patch }))} />
                    </Box>
                )}

                {destination === 'waitingFor' && (
                    <Box className={styles.form}>
                        <WaitingForFields value={waitingForForm} onChange={(patch) => setWaitingForForm((f) => ({ ...f, ...patch }))} people={people} />
                    </Box>
                )}
            </DialogContent>

            <DialogActions>
                {/* Skip hidden in single-item mode — there is nothing else to process */}
                {!isSingleItem && (
                    <Button onClick={() => void onSkip()} color="inherit">
                        Skip
                    </Button>
                )}
                <Button variant="contained" disabled={isConfirmDisabled()} onClick={() => void onConfirm()}>
                    {isSingleItem ? 'Confirm' : `Confirm${index + 1 < total ? ' & next' : ' & finish'}`}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
