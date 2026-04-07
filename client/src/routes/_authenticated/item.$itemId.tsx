import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import AssignmentTurnedInIcon from '@mui/icons-material/AssignmentTurnedIn';
import BoltIcon from '@mui/icons-material/Bolt';
import CalendarTodayIcon from '@mui/icons-material/CalendarToday';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import MoveToInboxIcon from '@mui/icons-material/MoveToInbox';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import type { IDBPDatabase } from 'idb';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { CalendarFields } from '../../components/clarify/CalendarFields';
import { NextActionFields } from '../../components/clarify/NextActionFields';
import {
    buildCalendarMeta,
    buildNextActionMeta,
    buildWaitingForMeta,
    type CalendarFormState,
    type Destination,
    emptyCalendar,
    emptyNextAction,
    emptyWaitingFor,
    type NextActionFormState,
    type WaitingForFormState,
} from '../../components/clarify/types';
import { WaitingForFields } from '../../components/clarify/WaitingForFields';
import { RoutineIndicator } from '../../components/RoutineIndicator';
import { useAppData } from '../../contexts/AppDataProvider';
import { clarifyToCalendar, clarifyToDone, clarifyToInbox, clarifyToNextAction, clarifyToTrash, clarifyToWaitingFor, updateItem } from '../../db/itemMutations';
import { useCalendarOptions } from '../../hooks/useCalendarOptions';
import type { EnergyLevel, MyDB, StoredItem, StoredPerson, StoredWorkContext } from '../../types/MyDB';
import styles from './-item.$itemId.module.css';

const VALID_DESTINATIONS = new Set<string>(['nextAction', 'calendar', 'waitingFor', 'done', 'trash']);

export const Route = createFileRoute('/_authenticated/item/$itemId')({
    // `dest` pre-selects a destination chip when navigating from the inbox action buttons.
    // Unknown/missing values fall back to null so the user sees a clean unselected state.
    validateSearch: (search) => ({
        // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature (TS4111) requires bracket notation on Record<string, unknown>
        dest: typeof search['dest'] === 'string' && VALID_DESTINATIONS.has(search['dest']) ? (search['dest'] as Destination) : null,
    }),
    component: ItemPage,
});

// ── Shared header ──────────────────────────────────────────────────────────────

function PageHeader({ title, onBack }: { title: string; onBack: () => void }) {
    return (
        <Box className={styles.header}>
            <IconButton onClick={onBack} size="small" aria-label="Go back">
                <ArrowBackIcon />
            </IconButton>
            <Typography variant="h6" fontWeight={600}>
                {title}
            </Typography>
        </Box>
    );
}

// ── Main dispatcher ────────────────────────────────────────────────────────────

function ItemPage() {
    const { db } = Route.useRouteContext();
    const { itemId } = Route.useParams();
    const { dest } = Route.useSearch();
    const { items, workContexts, people, refreshItems } = useAppData();
    const navigate = useNavigate();

    const item = items.find((i) => i._id === itemId) ?? null;

    // Item not found: stale navigation (already processed in another tab, or invalid deep-link).
    if (!item) {
        return (
            <Box className={styles.page}>
                <PageHeader title="Edit item" onBack={() => window.history.back()} />
                <Typography color="text.secondary" mt={4} textAlign="center">
                    Item not found — it may have already been processed.
                </Typography>
                <Button onClick={() => window.history.back()} sx={{ mt: 2, display: 'block', mx: 'auto' }}>
                    Go back
                </Button>
            </Box>
        );
    }

    // TypeScript doesn't propagate narrowing into nested function declarations — pin to a const.
    // Same pattern used in InboxBottomSheet for the same reason.
    const resolvedItem = item;

    // Navigate back to the list that corresponds to this item's status.
    function goBack() {
        if (resolvedItem.status === 'nextAction') {
            void navigate({ to: '/next-actions' });
        } else if (resolvedItem.status === 'calendar') {
            void navigate({ to: '/calendar' });
        } else if (resolvedItem.status === 'waitingFor') {
            void navigate({ to: '/waiting-for' });
        } else {
            void navigate({ to: '/inbox' });
        }
    }

    // Done/trash items should not be editable — guard before dispatching to edit forms.
    if (item.status === 'done' || item.status === 'trash') {
        return (
            <Box className={styles.page}>
                <PageHeader title="Item" onBack={goBack} />
                <Typography color="text.secondary" mt={4} textAlign="center">
                    This item has already been processed.
                </Typography>
            </Box>
        );
    }

    if (item.status === 'inbox') {
        return <InboxClarifyContent item={item} db={db} dest={dest} workContexts={workContexts} people={people} refreshItems={refreshItems} onBack={goBack} />;
    }

    if (item.status === 'nextAction') {
        return <NextActionEditContent item={item} db={db} workContexts={workContexts} people={people} refreshItems={refreshItems} onBack={goBack} />;
    }

    return <SimpleEditContent item={item} db={db} refreshItems={refreshItems} onBack={goBack} />;
}

// ── Inbox: clarify flow ────────────────────────────────────────────────────────

interface InboxClarifyProps {
    item: StoredItem;
    db: IDBPDatabase<MyDB>;
    dest: Destination | null;
    workContexts: StoredWorkContext[];
    people: StoredPerson[];
    refreshItems: () => Promise<void>;
    onBack: () => void;
}

function InboxClarifyContent({ item, db, dest, workContexts, people, refreshItems, onBack }: InboxClarifyProps) {
    // `dest` is captured once at mount — safe because TanStack Router unmounts this component
    // on every navigation, so the search param can never change under an existing instance.
    const [destination, setDestination] = useState<Destination | null>(dest);
    const { options: calendarOptions } = useCalendarOptions();
    const [nextActionForm, setNextActionForm] = useState<NextActionFormState>(emptyNextAction);
    const [calendarForm, setCalendarForm] = useState<CalendarFormState>(emptyCalendar);
    const [waitingForForm, setWaitingForForm] = useState<WaitingForFormState>(emptyWaitingFor);
    const [isSubmitting, setIsSubmitting] = useState(false);

    function isConfirmDisabled(): boolean {
        if (!destination) {
            return true;
        }
        if (destination === 'calendar' && !calendarForm.date) {
            return true;
        }
        if (destination === 'waitingFor' && !waitingForForm.waitingForPersonId) {
            return true;
        }
        return false;
    }

    async function onConfirm() {
        if (!destination || isSubmitting) {
            return;
        }
        setIsSubmitting(true);
        try {
            if (destination === 'trash') {
                await clarifyToTrash(db, item);
            } else if (destination === 'done') {
                await clarifyToDone(db, item);
            } else if (destination === 'nextAction') {
                await clarifyToNextAction(db, item, buildNextActionMeta(nextActionForm));
            } else if (destination === 'calendar') {
                await clarifyToCalendar(db, item, buildCalendarMeta(calendarForm, calendarOptions));
            } else if (destination === 'waitingFor') {
                await clarifyToWaitingFor(db, item, buildWaitingForMeta(waitingForForm));
            }
            await refreshItems();
        } finally {
            setIsSubmitting(false);
        }
        // Navigate after finally so a throwing refreshItems() doesn't silently dismiss the page.
        onBack();
    }

    return (
        <Box className={styles.page}>
            <PageHeader title="Clarify" onBack={onBack} />
            <Paper variant="outlined" className={styles.card}>
                <Typography variant="h6" fontWeight={500} mb={3}>
                    "{item.title}"
                </Typography>

                <Typography variant="caption" color="text.secondary" fontWeight={600} className={styles.sectionLabel}>
                    What is it?
                </Typography>
                <Stack direction="row" flexWrap="wrap" gap={1} mt={1} mb={3}>
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
                        <CalendarFields
                            value={calendarForm}
                            onChange={(patch) => setCalendarForm((f) => ({ ...f, ...patch }))}
                            calendarOptions={calendarOptions}
                        />
                    </Box>
                )}
                {destination === 'waitingFor' && (
                    <Box className={styles.form}>
                        <WaitingForFields value={waitingForForm} onChange={(patch) => setWaitingForForm((f) => ({ ...f, ...patch }))} people={people} />
                    </Box>
                )}

                <Box className={styles.actions}>
                    <Button onClick={onBack}>Cancel</Button>
                    <Button variant="contained" disabled={isConfirmDisabled() || isSubmitting} onClick={() => void onConfirm()}>
                        Confirm
                    </Button>
                </Box>
            </Paper>
        </Box>
    );
}

// ── Next action: full edit ─────────────────────────────────────────────────────

type MoveDest = 'calendar' | 'waitingFor';

interface NextActionEditProps {
    item: StoredItem;
    db: IDBPDatabase<MyDB>;
    workContexts: StoredWorkContext[];
    people: StoredPerson[];
    refreshItems: () => Promise<void>;
    onBack: () => void;
}

function NextActionEditContent({ item, db, workContexts, people, refreshItems, onBack }: NextActionEditProps) {
    const { routines } = useAppData();
    const { options: calendarOptions } = useCalendarOptions();
    const [title, setTitle] = useState(item.title);
    const [notes, setNotes] = useState(item.notes ?? '');
    const [notesTab, setNotesTab] = useState<0 | 1>(0);
    // Pre-populate from existing item so edits are incremental, not full rewrites.
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
    const [isSubmitting, setIsSubmitting] = useState(false);

    async function onSave() {
        const trimmedTitle = title.trim();
        if (!trimmedTitle || isSubmitting) {
            return;
        }
        setIsSubmitting(true);
        try {
            const trimmedNotes = notes.trim();
            // Destructure out all mutable optional fields before re-applying from form state,
            // so clearing a field (e.g. removing all contexts) actually removes it from the item.
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
            await refreshItems();
        } finally {
            setIsSubmitting(false);
        }
        // Navigate after finally so a throwing refreshItems() doesn't silently dismiss the page.
        onBack();
    }

    async function onMoveInstant(mutation: (db: IDBPDatabase<MyDB>, item: StoredItem) => Promise<StoredItem>) {
        if (isSubmitting) {
            return;
        }
        setIsSubmitting(true);
        try {
            await mutation(db, item);
            await refreshItems();
        } finally {
            setIsSubmitting(false);
        }
        // Navigate after finally so a throwing refreshItems() doesn't silently dismiss the page.
        onBack();
    }

    async function onConfirmCalendar() {
        if (isSubmitting) {
            return;
        }
        setIsSubmitting(true);
        try {
            await clarifyToCalendar(db, item, buildCalendarMeta(calForm, calendarOptions));
            await refreshItems();
        } finally {
            setIsSubmitting(false);
        }
        // Navigate after finally so a throwing refreshItems() doesn't silently dismiss the page.
        onBack();
    }

    async function onConfirmWaitingFor() {
        if (isSubmitting) {
            return;
        }
        setIsSubmitting(true);
        try {
            await clarifyToWaitingFor(db, item, buildWaitingForMeta(wfForm));
            await refreshItems();
        } finally {
            setIsSubmitting(false);
        }
        // Navigate after finally so a throwing refreshItems() doesn't silently dismiss the page.
        onBack();
    }

    return (
        <Box className={styles.page}>
            <PageHeader title="Edit next action" onBack={onBack} />
            <Paper variant="outlined" className={styles.card}>
                <Box className={styles.form}>
                    <TextField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} fullWidth required autoFocus />
                    {item.routineId && (
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                            <Typography variant="caption" color="text.secondary">
                                Part of routine:
                            </Typography>
                            <RoutineIndicator routineId={item.routineId} routineTitle={routines.find((r) => r._id === item.routineId)?.title} />
                        </Box>
                    )}

                    <div>
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
                            <div className={styles.preview}>
                                {notes.trim() ? <ReactMarkdown>{notes}</ReactMarkdown> : <span className={styles.empty}>Nothing to preview.</span>}
                            </div>
                        )}
                    </div>

                    <Divider />

                    <NextActionFields value={naForm} onChange={(patch) => setNaForm((f) => ({ ...f, ...patch }))} workContexts={workContexts} people={people} />

                    <Divider />

                    <Box className={styles.moveToSection}>
                        <Typography variant="caption" color="text.secondary" fontWeight={600} className={styles.sectionLabel}>
                            Move to
                        </Typography>
                        <Stack direction="row" flexWrap="wrap" gap={1} mt={1}>
                            <Chip
                                icon={<MoveToInboxIcon />}
                                label="Inbox"
                                variant="outlined"
                                onClick={() => void onMoveInstant(clarifyToInbox)}
                                disabled={isSubmitting}
                            />
                            <Chip
                                icon={<CalendarTodayIcon />}
                                label="Calendar"
                                variant={moveDest === 'calendar' ? 'filled' : 'outlined'}
                                color={moveDest === 'calendar' ? 'primary' : 'default'}
                                onClick={() => setMoveDest((prev) => (prev === 'calendar' ? null : 'calendar'))}
                                disabled={isSubmitting}
                            />
                            <Chip
                                icon={<HourglassEmptyIcon />}
                                label="Waiting For"
                                variant={moveDest === 'waitingFor' ? 'filled' : 'outlined'}
                                color={moveDest === 'waitingFor' ? 'primary' : 'default'}
                                onClick={() => setMoveDest((prev) => (prev === 'waitingFor' ? null : 'waitingFor'))}
                                disabled={isSubmitting}
                            />
                            <Chip
                                icon={<CheckCircleOutlineIcon />}
                                label="Done"
                                variant="outlined"
                                color="success"
                                onClick={() => void onMoveInstant(clarifyToDone)}
                                disabled={isSubmitting}
                            />
                            <Chip
                                icon={<DeleteOutlineIcon />}
                                label="Trash"
                                variant="outlined"
                                color="error"
                                onClick={() => void onMoveInstant(clarifyToTrash)}
                                disabled={isSubmitting}
                            />
                        </Stack>

                        {moveDest === 'calendar' && (
                            <Box className={styles.subForm}>
                                <CalendarFields
                                    value={calForm}
                                    onChange={(patch) => setCalForm((f) => ({ ...f, ...patch }))}
                                    calendarOptions={calendarOptions}
                                />
                                <Stack direction="row" gap={1} mt={1.5}>
                                    <Button size="small" onClick={() => setMoveDest(null)}>
                                        Cancel
                                    </Button>
                                    <Button size="small" variant="contained" disabled={!calForm.date || isSubmitting} onClick={() => void onConfirmCalendar()}>
                                        Confirm move to Calendar
                                    </Button>
                                </Stack>
                            </Box>
                        )}

                        {moveDest === 'waitingFor' && (
                            <Box className={styles.subForm}>
                                <WaitingForFields value={wfForm} onChange={(patch) => setWfForm((f) => ({ ...f, ...patch }))} people={people} />
                                <Stack direction="row" gap={1} mt={1.5}>
                                    <Button size="small" onClick={() => setMoveDest(null)}>
                                        Cancel
                                    </Button>
                                    <Button
                                        size="small"
                                        variant="contained"
                                        disabled={!wfForm.waitingForPersonId || isSubmitting}
                                        onClick={() => void onConfirmWaitingFor()}
                                    >
                                        Confirm move to Waiting For
                                    </Button>
                                </Stack>
                            </Box>
                        )}
                    </Box>
                </Box>

                <Box className={styles.actions}>
                    <Button onClick={onBack}>Cancel</Button>
                    <Button variant="contained" disabled={!title.trim() || isSubmitting} onClick={() => void onSave()}>
                        Save changes
                    </Button>
                </Box>
            </Paper>
        </Box>
    );
}

// ── Calendar / Waiting For: simple title + notes edit ─────────────────────────

interface SimpleEditProps {
    item: StoredItem;
    db: IDBPDatabase<MyDB>;
    refreshItems: () => Promise<void>;
    onBack: () => void;
}

function SimpleEditContent({ item, db, refreshItems, onBack }: SimpleEditProps) {
    const [title, setTitle] = useState(item.title);
    const [notes, setNotes] = useState(item.notes ?? '');
    const [notesTab, setNotesTab] = useState<0 | 1>(0);
    const [isSubmitting, setIsSubmitting] = useState(false);

    const pageTitle = item.status === 'calendar' ? 'Edit calendar item' : 'Edit waiting for';

    async function onSave() {
        const trimmedTitle = title.trim();
        if (!trimmedTitle || isSubmitting) {
            return;
        }
        setIsSubmitting(true);
        try {
            const trimmedNotes = notes.trim();
            // exactOptionalPropertyTypes: omit the key rather than assigning undefined
            const { notes: _n, ...rest } = item;
            const updated: StoredItem = trimmedNotes ? { ...rest, title: trimmedTitle, notes: trimmedNotes } : { ...rest, title: trimmedTitle };
            await updateItem(db, updated);
            await refreshItems();
        } finally {
            setIsSubmitting(false);
        }
        // Navigate after finally so a throwing refreshItems() doesn't silently dismiss the page.
        onBack();
    }

    return (
        <Box className={styles.page}>
            <PageHeader title={pageTitle} onBack={onBack} />
            <Paper variant="outlined" className={styles.card}>
                <Box className={styles.form}>
                    <TextField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} fullWidth required autoFocus />

                    <div>
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
                                rows={6}
                                placeholder="Supports **bold**, _italic_, `code`, lists, etc."
                            />
                        ) : (
                            <div className={styles.preview}>
                                {notes.trim() ? <ReactMarkdown>{notes}</ReactMarkdown> : <span className={styles.empty}>Nothing to preview.</span>}
                            </div>
                        )}
                    </div>
                </Box>

                <Box className={styles.actions}>
                    <Button onClick={onBack}>Cancel</Button>
                    <Button variant="contained" disabled={!title.trim() || isSubmitting} onClick={() => void onSave()}>
                        Save
                    </Button>
                </Box>
            </Paper>
        </Box>
    );
}
