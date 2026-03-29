import AssignmentTurnedInIcon from '@mui/icons-material/AssignmentTurnedIn';
import BoltIcon from '@mui/icons-material/Bolt';
import CalendarTodayIcon from '@mui/icons-material/CalendarToday';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormLabel from '@mui/material/FormLabel';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { useState } from 'react';
import { clarifyToCalendar, clarifyToDone, clarifyToNextAction, clarifyToTrash, clarifyToWaitingFor } from '../db/itemMutations';
import type { EnergyLevel, MyDB, StoredItem, StoredPerson, StoredWorkContext } from '../types/MyDB';
import styles from './ClarifyDialog.module.css';

type Destination = 'nextAction' | 'calendar' | 'waitingFor' | 'done' | 'trash';

interface NextActionForm {
    workContextIds: string[];
    energy: EnergyLevel | '';
    time: string;
    urgent: boolean;
    focus: boolean;
    expectedBy: string;
    ignoreBefore: string;
}

interface CalendarForm {
    date: string;
    startTime: string;
    endTime: string;
}

interface WaitingForForm {
    waitingForPersonId: string;
    expectedBy: string;
    ignoreBefore: string;
}

const emptyNextAction: NextActionForm = {
    workContextIds: [],
    energy: '',
    time: '',
    urgent: false,
    focus: false,
    expectedBy: '',
    ignoreBefore: '',
};

const emptyCalendar: CalendarForm = { date: '', startTime: '', endTime: '' };
const emptyWaitingFor: WaitingForForm = { waitingForPersonId: '', expectedBy: '', ignoreBefore: '' };

interface Props {
    items: StoredItem[];
    db: IDBPDatabase<MyDB>;
    people: StoredPerson[];
    workContexts: StoredWorkContext[];
    onClose: () => void;
    onItemProcessed: () => Promise<void>;
}

export function ClarifyDialog({ items, db, people, workContexts, onClose, onItemProcessed }: Props) {
    const [index, setIndex] = useState(0);
    const [destination, setDestination] = useState<Destination | null>(null);
    const [nextActionForm, setNextActionForm] = useState<NextActionForm>(emptyNextAction);
    const [calendarForm, setCalendarForm] = useState<CalendarForm>(emptyCalendar);
    const [waitingForForm, setWaitingForForm] = useState<WaitingForForm>(emptyWaitingFor);
    const [done, setDone] = useState(false);

    const currentItem = items[index];
    const total = items.length;

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
            // exactOptionalPropertyTypes requires we omit undefined keys entirely rather than
            // passing them explicitly, so we build the meta object incrementally.
            const meta = {
                ...(nextActionForm.workContextIds.length && { workContextIds: nextActionForm.workContextIds }),
                ...(nextActionForm.energy && { energy: nextActionForm.energy }),
                ...(nextActionForm.time && { time: Number(nextActionForm.time) }),
                ...(nextActionForm.urgent && { urgent: nextActionForm.urgent }),
                ...(nextActionForm.focus && { focus: nextActionForm.focus }),
                ...(nextActionForm.expectedBy && { expectedBy: nextActionForm.expectedBy }),
                ...(nextActionForm.ignoreBefore && { ignoreBefore: nextActionForm.ignoreBefore }),
            };
            await clarifyToNextAction(db, item, meta);
            return;
        }
        if (dest === 'calendar') {
            // Combine date + time into ISO datetime; fall back to start of day if no time given
            const startIso = calendarForm.date
                ? dayjs(`${calendarForm.date}${calendarForm.startTime ? `T${calendarForm.startTime}` : ''}`).toISOString()
                : dayjs().toISOString();
            const endIso =
                calendarForm.date && calendarForm.endTime
                    ? dayjs(`${calendarForm.date}T${calendarForm.endTime}`).toISOString()
                    : dayjs(startIso).add(1, 'hour').toISOString();
            await clarifyToCalendar(db, item, startIso, endIso);
            return;
        }
        if (dest === 'waitingFor') {
            // exactOptionalPropertyTypes requires omitting undefined keys rather than passing them explicitly.
            const meta = {
                waitingForPersonId: waitingForForm.waitingForPersonId,
                ...(waitingForForm.expectedBy && { expectedBy: waitingForForm.expectedBy }),
                ...(waitingForForm.ignoreBefore && { ignoreBefore: waitingForForm.ignoreBefore }),
            };
            await clarifyToWaitingFor(db, item, meta);
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
                <DialogContent sx={{ textAlign: 'center', py: 5 }}>
                    <AssignmentTurnedInIcon sx={{ fontSize: 56, color: 'success.main', mb: 2 }} />
                    <Typography variant="h6" fontWeight={600}>
                        Inbox clear!
                    </Typography>
                    <Typography variant="body2" color="text.secondary" mt={1}>
                        All {total} item{total !== 1 ? 's' : ''} processed.
                    </Typography>
                </DialogContent>
                <DialogActions sx={{ justifyContent: 'center', pb: 3 }}>
                    <Button variant="contained" onClick={onClose}>
                        Done
                    </Button>
                </DialogActions>
            </Dialog>
        );
    }

    return (
        <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
            <DialogTitle sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Typography variant="subtitle1" fontWeight={600}>
                    Clarify
                </Typography>
                <Typography variant="caption" color="text.secondary">
                    {index + 1} of {total}
                </Typography>
            </DialogTitle>

            <DialogContent dividers>
                {/* Item title */}
                <Typography variant="h6" fontWeight={500} mb={3}>
                    "{currentItem?.title}"
                </Typography>

                {/* Destination picker */}
                <FormLabel sx={{ display: 'block', mb: 1 }}>
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

                {/* Next Action form */}
                {destination === 'nextAction' && (
                    <Box className={styles.form}>
                        {workContexts.length > 0 && (
                            <Box>
                                <FormLabel>
                                    <Typography variant="caption" color="text.secondary">
                                        Work contexts
                                    </Typography>
                                </FormLabel>
                                <Stack direction="row" flexWrap="wrap" gap={0.75} mt={0.5}>
                                    {workContexts.map((ctx) => (
                                        <Chip
                                            key={ctx._id}
                                            label={ctx.name}
                                            size="small"
                                            variant={nextActionForm.workContextIds.includes(ctx._id) ? 'filled' : 'outlined'}
                                            color={nextActionForm.workContextIds.includes(ctx._id) ? 'primary' : 'default'}
                                            onClick={() =>
                                                setNextActionForm((f) => ({
                                                    ...f,
                                                    workContextIds: f.workContextIds.includes(ctx._id)
                                                        ? f.workContextIds.filter((id) => id !== ctx._id)
                                                        : [...f.workContextIds, ctx._id],
                                                }))
                                            }
                                        />
                                    ))}
                                </Stack>
                            </Box>
                        )}

                        <Box>
                            <FormLabel>
                                <Typography variant="caption" color="text.secondary">
                                    Energy
                                </Typography>
                            </FormLabel>
                            <ToggleButtonGroup
                                exclusive
                                size="small"
                                value={nextActionForm.energy || null}
                                onChange={(_e, val: EnergyLevel | null) => setNextActionForm((f) => ({ ...f, energy: val ?? '' }))}
                                sx={{ mt: 0.5, display: 'flex' }}
                            >
                                <ToggleButton value="low">Low</ToggleButton>
                                <ToggleButton value="medium">Medium</ToggleButton>
                                <ToggleButton value="high">High</ToggleButton>
                            </ToggleButtonGroup>
                        </Box>

                        <TextField
                            label="Time estimate (min)"
                            value={nextActionForm.time}
                            onChange={(e) => setNextActionForm((f) => ({ ...f, time: e.target.value }))}
                            type="number"
                            size="small"
                            sx={{ width: 180 }}
                            slotProps={{ htmlInput: { min: 1 } }}
                        />

                        <Stack direction="row" gap={2}>
                            <FormControlLabel
                                control={
                                    <Checkbox
                                        size="small"
                                        checked={nextActionForm.urgent}
                                        onChange={(e) => setNextActionForm((f) => ({ ...f, urgent: e.target.checked }))}
                                    />
                                }
                                label={<Typography variant="body2">Urgent</Typography>}
                            />
                            <FormControlLabel
                                control={
                                    <Checkbox
                                        size="small"
                                        checked={nextActionForm.focus}
                                        onChange={(e) => setNextActionForm((f) => ({ ...f, focus: e.target.checked }))}
                                    />
                                }
                                label={<Typography variant="body2">Needs focus</Typography>}
                            />
                        </Stack>

                        <Stack direction={{ xs: 'column', sm: 'row' }} gap={2}>
                            <TextField
                                label="Expected by"
                                type="date"
                                value={nextActionForm.expectedBy}
                                onChange={(e) => setNextActionForm((f) => ({ ...f, expectedBy: e.target.value }))}
                                size="small"
                                slotProps={{ inputLabel: { shrink: true } }}
                            />
                            <TextField
                                label="Ignore before"
                                type="date"
                                value={nextActionForm.ignoreBefore}
                                onChange={(e) => setNextActionForm((f) => ({ ...f, ignoreBefore: e.target.value }))}
                                size="small"
                                slotProps={{ inputLabel: { shrink: true } }}
                            />
                        </Stack>
                    </Box>
                )}

                {/* Calendar form */}
                {destination === 'calendar' && (
                    <Box className={styles.form}>
                        <TextField
                            label="Date"
                            type="date"
                            value={calendarForm.date}
                            onChange={(e) => setCalendarForm((f) => ({ ...f, date: e.target.value }))}
                            size="small"
                            required
                            slotProps={{ inputLabel: { shrink: true } }}
                        />
                        <Stack direction="row" gap={2}>
                            <TextField
                                label="Start time"
                                type="time"
                                value={calendarForm.startTime}
                                onChange={(e) => setCalendarForm((f) => ({ ...f, startTime: e.target.value }))}
                                size="small"
                                slotProps={{ inputLabel: { shrink: true } }}
                            />
                            <TextField
                                label="End time"
                                type="time"
                                value={calendarForm.endTime}
                                onChange={(e) => setCalendarForm((f) => ({ ...f, endTime: e.target.value }))}
                                size="small"
                                slotProps={{ inputLabel: { shrink: true } }}
                            />
                        </Stack>
                    </Box>
                )}

                {/* Waiting For form */}
                {destination === 'waitingFor' && (
                    <Box className={styles.form}>
                        {people.length === 0 ? (
                            <Typography variant="body2" color="text.secondary">
                                No people yet — add contacts in the People section first.
                            </Typography>
                        ) : (
                            <TextField
                                select
                                label="Waiting for"
                                value={waitingForForm.waitingForPersonId}
                                onChange={(e) => setWaitingForForm((f) => ({ ...f, waitingForPersonId: e.target.value }))}
                                size="small"
                                required
                                sx={{ minWidth: 200 }}
                            >
                                {people.map((p) => (
                                    <MenuItem key={p._id} value={p._id}>
                                        {p.name}
                                    </MenuItem>
                                ))}
                            </TextField>
                        )}
                        <Stack direction={{ xs: 'column', sm: 'row' }} gap={2}>
                            <TextField
                                label="Expected by"
                                type="date"
                                value={waitingForForm.expectedBy}
                                onChange={(e) => setWaitingForForm((f) => ({ ...f, expectedBy: e.target.value }))}
                                size="small"
                                slotProps={{ inputLabel: { shrink: true } }}
                            />
                            <TextField
                                label="Ignore before"
                                type="date"
                                value={waitingForForm.ignoreBefore}
                                onChange={(e) => setWaitingForForm((f) => ({ ...f, ignoreBefore: e.target.value }))}
                                size="small"
                                slotProps={{ inputLabel: { shrink: true } }}
                            />
                        </Stack>
                    </Box>
                )}
            </DialogContent>

            <DialogActions>
                <Button onClick={() => void onSkip()} color="inherit">
                    Skip
                </Button>
                <Button variant="contained" disabled={isConfirmDisabled()} onClick={() => void onConfirm()}>
                    Confirm{index + 1 < total ? ' & next' : ' & finish'}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
