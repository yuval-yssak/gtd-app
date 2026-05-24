import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import HelpOutlineIcon from '@mui/icons-material/HelpOutlined';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import type { IDBPDatabase } from 'idb';
import { useState, useTransition } from 'react';
import { API_SERVER } from '../../constants/globals';
import { useAppData } from '../../contexts/AppDataProvider';
import { updatePerson } from '../../db/personMutations';
import type { GCalAttendee, GCalResponseStatus, MyDB, StoredItem, StoredPerson } from '../../types/MyDB';
import { PersonEditDialog } from '../people/PersonEditDialog';
import { QuickCreatePersonDialog } from '../people/QuickCreatePersonDialog';
import styles from './MeetingDetails.module.css';
import {
    addAttendeeByEmail,
    findPersonByEmail,
    findSelfAttendee,
    formatResponseSummary,
    isAttendeeMembershipChange,
    isPlausibleEmail,
    removeAttendeeByEmail,
} from './meetingDetailsLogic';

export type RsvpStatus = 'accepted' | 'declined' | 'tentative';

interface MeetingDetailsProps {
    item: StoredItem;
    db: IDBPDatabase<MyDB>;
    /**
     * Owner id for newly created people; matches the item owner so cross-account references stay
     * consistent. Defaults to item.userId when omitted.
     */
    ownerUserIdForNewPeople?: string;
    /**
     * Caller decides what an RSVP click means — the dialog calls `onRsvp(status)` and reconciles
     * on the returned promise. When `scopeMissing` resolves true the parent surfaces the
     * re-consent affordance (`reconsentUrl` is passed through `scopeMissingReconsentUrl`).
     */
    onRsvp: (status: RsvpStatus) => Promise<void>;
    onAttendeesChange: (next: GCalAttendee[]) => Promise<void>;
    /** Re-consent URL surfaced by the most recent 403 scope_missing RSVP response. */
    scopeMissingReconsentUrl?: string;
    /**
     * Called after the user closes the re-consent popup. The parent should refetch the calendar
     * integrations list and clear `scopeMissingReconsentUrl` so the RSVP buttons re-appear.
     */
    onReconsentClosed?: () => void;
}

// Discriminated union the Autocomplete operates on. Two arms: a known person from the local
// roster, or a brand-new email typed inline by the user.
type AttendeeOption = { kind: 'person'; person: StoredPerson } | { kind: 'newEmail'; newEmail: string };

const RSVP_BUTTONS: Array<{ status: RsvpStatus; label: string; color: 'success' | 'error' | 'warning' }> = [
    { status: 'accepted', label: 'Accept', color: 'success' },
    { status: 'declined', label: 'Decline', color: 'error' },
    { status: 'tentative', label: 'Tentative', color: 'warning' },
];

/**
 * Maps a GCal response status to the MUI Chip color name. Default + `outlined` styling for
 * `needsAction` keeps it visually distinct from a deliberate decision.
 */
function chipColorFor(status: GCalResponseStatus): 'success' | 'error' | 'warning' | 'default' {
    if (status === 'accepted') return 'success';
    if (status === 'declined') return 'error';
    if (status === 'tentative') return 'warning';
    return 'default';
}

/**
 * Collapsible meeting-details panel for a GCal-linked calendar item. Renders nothing when the
 * item carries neither an organizer nor any attendees — the caller can mount it unconditionally
 * and let the component self-suppress.
 */
export function MeetingDetails({
    item,
    db,
    ownerUserIdForNewPeople,
    onRsvp,
    onAttendeesChange,
    scopeMissingReconsentUrl,
    onReconsentClosed,
}: MeetingDetailsProps) {
    const { people } = useAppData();
    const attendees = item.attendees ?? [];
    const organizer = item.organizer;
    const creator = item.creator;

    if (!organizer && attendees.length === 0) {
        return null;
    }

    const self = findSelfAttendee(attendees);
    const showCreator = Boolean(creator && (!organizer || creator.email.toLowerCase() !== organizer.email.toLowerCase()));
    const summary = formatResponseSummary(attendees);

    return (
        <Accordion className={styles.accordion} data-testid="meetingDetails" disableGutters>
            <AccordionSummary expandIcon={<ExpandMoreIcon />} data-testid="meetingDetailsSummary">
                <Box className={styles.summaryHeader}>
                    <Typography variant="body2" className={styles.summaryTitle}>
                        {organizer ? `Organizer: ${organizer.displayName ?? organizer.email}` : 'Meeting details'}
                    </Typography>
                    {summary && (
                        <Typography variant="caption" color="text.secondary">
                            {summary}
                        </Typography>
                    )}
                </Box>
            </AccordionSummary>
            <AccordionDetails>
                <Box className={styles.body}>
                    {organizer && (
                        <Box>
                            <Typography variant="caption" color="text.secondary">
                                Organizer
                            </Typography>
                            <Typography variant="body2">{organizer.displayName ?? organizer.email}</Typography>
                            {showCreator && creator && (
                                <Typography variant="caption" color="text.secondary" data-testid="meetingCreator">
                                    Created by {creator.displayName ?? creator.email}
                                </Typography>
                            )}
                        </Box>
                    )}
                    <AttendeesEditor
                        db={db}
                        attendees={attendees}
                        people={people}
                        selfEmail={self?.email}
                        ownerUserIdForNewPeople={ownerUserIdForNewPeople ?? item.userId}
                        isRoutineInstance={Boolean(item.routineId)}
                        onAttendeesChange={onAttendeesChange}
                    />
                    {self && (
                        <RsvpButtons
                            currentStatus={self.responseStatus}
                            onRsvp={onRsvp}
                            {...(scopeMissingReconsentUrl ? { scopeMissingReconsentUrl } : {})}
                            {...(onReconsentClosed ? { onReconsentClosed } : {})}
                        />
                    )}
                </Box>
            </AccordionDetails>
        </Accordion>
    );
}

interface AttendeesEditorProps {
    db: IDBPDatabase<MyDB>;
    attendees: GCalAttendee[];
    people: StoredPerson[];
    selfEmail: string | undefined;
    ownerUserIdForNewPeople: string;
    /**
     * When true, the parent item was generated by a routine. The first add/remove triggers a
     * detach-warning dialog explaining that the change forks the occurrence from the routine series.
     * RSVP-only flips don't trigger this (they go through the dedicated RsvpButtons path).
     */
    isRoutineInstance: boolean;
    onAttendeesChange: (next: GCalAttendee[]) => Promise<void>;
}

function AttendeesEditor({ db, attendees, people, selfEmail, ownerUserIdForNewPeople, isRoutineInstance, onAttendeesChange }: AttendeesEditorProps) {
    // Quick-create modal state: which email is being promoted to a person, or null when closed.
    const [quickCreateEmail, setQuickCreateEmail] = useState<string | null>(null);
    // The "add email to person" inline flow — when the user picks a person without an email, we
    // open this row so they can type one before the attendee is committed.
    const [pendingPersonEmail, setPendingPersonEmail] = useState<{ person: StoredPerson; email: string } | null>(null);
    // Person-edit dialog target when a linked attendee chip is clicked. null when closed.
    const [personEditTarget, setPersonEditTarget] = useState<StoredPerson | null>(null);
    // Detach-warning state for routine-instance items. `pendingMutation` holds the user's *intent*
    // as a delta (add email X / remove email Y), gated behind the confirm dialog. Storing as a
    // delta — not a snapshot — lets us recompute against the latest `attendees` at confirm time,
    // so a concurrent inbound attendee mutation (SSE pull, RSVP echo) is not silently clobbered.
    // `detachAcknowledged` flips true after the first confirm so subsequent edits skip the dialog.
    type PendingMutation = { kind: 'add'; email: string; displayName?: string } | { kind: 'remove'; email: string };
    const [pendingMutation, setPendingMutation] = useState<PendingMutation | null>(null);
    const [detachAcknowledged, setDetachAcknowledged] = useState(false);

    /** Applies a pending mutation delta against the latest attendees list. */
    function applyMutation(prev: GCalAttendee[], mutation: PendingMutation): GCalAttendee[] {
        if (mutation.kind === 'remove') {
            return removeAttendeeByEmail(prev, mutation.email);
        }
        return addAttendeeByEmail(prev, mutation.email, mutation.displayName);
    }

    /**
     * Gates a mutation behind the detach-warning dialog when the parent is a routine-instance and
     * the change moves the attendee membership. Pure RSVP flips bypass the dialog because they go
     * through the dedicated RsvpButtons path; the dialog only fires here.
     */
    async function gatedCommit(mutation: PendingMutation) {
        const next = applyMutation(attendees, mutation);
        if (isRoutineInstance && !detachAcknowledged && isAttendeeMembershipChange(attendees, next)) {
            setPendingMutation(mutation);
            return;
        }
        await onAttendeesChange(next);
    }

    async function onConfirmDetach() {
        if (!pendingMutation) {
            return;
        }
        setDetachAcknowledged(true);
        // Recompute against the latest attendees so a concurrent inbound change (e.g. SSE-delivered
        // attendee mutation from another device) is not clobbered by the user's stale snapshot.
        const next = applyMutation(attendees, pendingMutation);
        setPendingMutation(null);
        await onAttendeesChange(next);
    }

    async function onRemoveAttendee(email: string) {
        await gatedCommit({ kind: 'remove', email });
    }

    async function commitAttendee(email: string, displayName?: string) {
        await gatedCommit(displayName ? { kind: 'add', email, displayName } : { kind: 'add', email });
    }

    async function onCommitPersonWithEmail() {
        if (!pendingPersonEmail) return;
        const { person, email } = pendingPersonEmail;
        if (!isPlausibleEmail(email)) return;
        await updatePerson(db, { ...person, email: email.trim() });
        await commitAttendee(email.trim(), person.name);
        setPendingPersonEmail(null);
    }

    return (
        <Box>
            <Typography variant="caption" color="text.secondary">
                Attendees
            </Typography>
            <Box className={styles.attendeesList} data-testid="attendeesList">
                {attendees.map((attendee) => (
                    <AttendeeChip
                        key={attendee.email}
                        attendee={attendee}
                        person={findPersonByEmail(people, attendee.email)}
                        isSelf={Boolean(selfEmail && attendee.email.toLowerCase() === selfEmail.toLowerCase())}
                        onRemove={() => void onRemoveAttendee(attendee.email)}
                        onSaveAsPerson={() => setQuickCreateEmail(attendee.email)}
                        onEditPerson={(p) => setPersonEditTarget(p)}
                    />
                ))}
            </Box>
            <AttendeePicker
                people={people}
                onPickPerson={(person) => {
                    if (person.email) {
                        void commitAttendee(person.email, person.name);
                        return;
                    }
                    setPendingPersonEmail({ person, email: '' });
                }}
                onPickEmail={(email) => void commitAttendee(email)}
            />
            {pendingPersonEmail && (
                <Box className={styles.inlineInputRow} data-testid="addEmailToPersonRow">
                    <Typography variant="caption">Add email for {pendingPersonEmail.person.name}:</Typography>
                    <TextField
                        size="small"
                        type="email"
                        value={pendingPersonEmail.email}
                        onChange={(e) => setPendingPersonEmail({ person: pendingPersonEmail.person, email: e.target.value })}
                        className={styles.inlineInput}
                        data-testid="addEmailInput"
                    />
                    <Button
                        size="small"
                        onClick={() => void onCommitPersonWithEmail()}
                        disabled={!isPlausibleEmail(pendingPersonEmail.email)}
                        data-testid="addEmailCommit"
                    >
                        Add
                    </Button>
                    <Button size="small" onClick={() => setPendingPersonEmail(null)}>
                        Cancel
                    </Button>
                </Box>
            )}
            {/* Mount conditionally so the dialog's useState(prefilledEmail) re-initializes each open;
                keeping it mounted with a toggled `open` would freeze the email field at its first value (''). */}
            {quickCreateEmail !== null && (
                <QuickCreatePersonDialog
                    prefilledEmail={quickCreateEmail}
                    db={db}
                    ownerUserId={ownerUserIdForNewPeople}
                    onCreated={() => setQuickCreateEmail(null)}
                    onCancel={() => setQuickCreateEmail(null)}
                />
            )}
            {personEditTarget && (
                <PersonEditDialog db={db} person={personEditTarget} onSaved={() => setPersonEditTarget(null)} onCancel={() => setPersonEditTarget(null)} />
            )}
            <Dialog open={pendingMutation !== null} onClose={() => setPendingMutation(null)} maxWidth="xs" fullWidth>
                <DialogTitle>Detach this occurrence?</DialogTitle>
                <DialogContent>
                    <DialogContentText data-testid="detachWarningText">
                        Changing attendees here forks just this date from the recurring event. Future attendee changes on the routine series won't apply to this
                        occurrence.
                    </DialogContentText>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setPendingMutation(null)} data-testid="detachWarningCancel">
                        Cancel
                    </Button>
                    <Button variant="contained" onClick={() => void onConfirmDetach()} data-testid="detachWarningConfirm">
                        Detach
                    </Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}

interface AttendeeChipProps {
    attendee: GCalAttendee;
    person: StoredPerson | undefined;
    isSelf: boolean;
    onRemove: () => void;
    onSaveAsPerson: () => void;
    onEditPerson: (person: StoredPerson) => void;
}

function AttendeeChip({ attendee, person, isSelf, onRemove, onSaveAsPerson, onEditPerson }: AttendeeChipProps) {
    const label = attendee.displayName ?? attendee.email;
    const color = chipColorFor(attendee.responseStatus);
    // Chip variant convention: needsAction renders outlined (the "no answer" visual), every other
    // state renders filled in the relevant color.
    const variant = attendee.responseStatus === 'needsAction' ? 'outlined' : 'filled';
    // Click behavior:
    //  - self chip → not interactive.
    //  - unlinked attendee → opens QuickCreatePersonDialog (existing onSaveAsPerson behavior).
    //  - linked attendee → opens PersonEditDialog for that person (symmetric edit affordance).
    const clickHandler = isSelf ? undefined : person ? () => onEditPerson(person) : onSaveAsPerson;
    return (
        <Tooltip title={attendee.email} placement="top">
            <span>
                <Chip
                    label={person ? `${label} ✓` : label}
                    color={color}
                    variant={variant}
                    size="small"
                    onDelete={isSelf ? undefined : onRemove}
                    {...(isSelf ? {} : { deleteIcon: <CloseIcon /> })}
                    {...(clickHandler ? { onClick: clickHandler, clickable: true } : {})}
                    data-testid={`attendeeChip-${attendee.email}`}
                />
            </span>
        </Tooltip>
    );
}

interface AttendeePickerProps {
    people: StoredPerson[];
    onPickPerson: (person: StoredPerson) => void;
    onPickEmail: (email: string) => void;
}

function AttendeePicker({ people, onPickPerson, onPickEmail }: AttendeePickerProps) {
    const [input, setInput] = useState('');

    function onSelected(value: AttendeeOption | string | null) {
        if (!value) return;
        if (typeof value === 'string') {
            // The Autocomplete `freeSolo` path hands back a raw string on Enter / blur — treat it
            // as a typed email if it looks like one, otherwise discard.
            if (isPlausibleEmail(value)) onPickEmail(value.trim());
            setInput('');
            return;
        }
        if (value.kind === 'person') {
            onPickPerson(value.person);
        } else {
            onPickEmail(value.newEmail);
        }
        setInput('');
    }

    return (
        <Autocomplete<AttendeeOption, false, false, true>
            freeSolo
            size="small"
            options={people.map<AttendeeOption>((person) => ({ kind: 'person', person }))}
            // Hide-when-empty: the Autocomplete pops only after the user starts typing, keeping
            // the form compact when no one is being added.
            inputValue={input}
            onInputChange={(_, next) => setInput(next)}
            onChange={(_, value) => onSelected(value)}
            getOptionLabel={(option) => {
                if (typeof option === 'string') return option;
                if (option.kind === 'newEmail') return option.newEmail;
                return option.person.email ? `${option.person.name} (${option.person.email})` : option.person.name;
            }}
            renderOption={(props, option) => {
                if (typeof option === 'string' || option.kind === 'newEmail') return null;
                const { person } = option;
                return (
                    <li {...props} key={person._id} data-testid={`attendeePickerOption-${person._id}`}>
                        <Box>
                            <Typography variant="body2">{person.name}</Typography>
                            {person.email ? (
                                <Typography variant="caption" color="text.secondary">
                                    {person.email}
                                </Typography>
                            ) : (
                                <Typography variant="caption" color="primary">
                                    add email →
                                </Typography>
                            )}
                        </Box>
                    </li>
                );
            }}
            filterOptions={(options, state) => {
                const trimmed = state.inputValue.trim().toLowerCase();
                const matchedPeople = trimmed
                    ? options.filter((o) => {
                          if (o.kind !== 'person') return false;
                          return o.person.name.toLowerCase().includes(trimmed) || (o.person.email ?? '').toLowerCase().includes(trimmed);
                      })
                    : options;
                // Surface a synthetic "type new email" row whenever the input parses as an email
                // and isn't already represented by a matched person.
                if (isPlausibleEmail(state.inputValue) && !matchedPeople.some((o) => o.kind === 'person' && (o.person.email ?? '').toLowerCase() === trimmed)) {
                    return [...matchedPeople, { kind: 'newEmail', newEmail: state.inputValue.trim() }];
                }
                return matchedPeople;
            }}
            renderInput={(params) => <TextField {...params} placeholder="Add attendee…" data-testid="attendeePickerInput" />}
        />
    );
}

interface RsvpButtonsProps {
    currentStatus: GCalResponseStatus;
    onRsvp: (status: RsvpStatus) => Promise<void>;
    scopeMissingReconsentUrl?: string;
    onReconsentClosed?: () => void;
}

function RsvpButtons({ currentStatus, onRsvp, scopeMissingReconsentUrl, onReconsentClosed }: RsvpButtonsProps) {
    const [isPending, startRsvp] = useTransition();

    if (scopeMissingReconsentUrl) {
        return (
            <Box className={styles.rsvpButtons} data-testid="rsvpReconsent">
                <Tooltip title="Google needs additional permissions before RSVPs can be sent.">
                    <Button
                        variant="contained"
                        color="primary"
                        onClick={() => openReconsentPopup(scopeMissingReconsentUrl, onReconsentClosed)}
                        data-testid="rsvpReconsentButton"
                    >
                        RSVP — authorize
                    </Button>
                </Tooltip>
            </Box>
        );
    }

    return (
        <Box className={styles.rsvpButtons} data-testid="rsvpButtons">
            {RSVP_BUTTONS.map((cfg) => {
                const isSelected = currentStatus === cfg.status;
                return (
                    <Button
                        key={cfg.status}
                        size="small"
                        variant={isSelected ? 'contained' : 'outlined'}
                        color={cfg.color}
                        disabled={isPending}
                        startIcon={isSelected ? <CheckIcon /> : <HelpOutlineIcon />}
                        onClick={() => startRsvp(async () => await onRsvp(cfg.status))}
                        data-testid={`rsvp-${cfg.status}`}
                    >
                        {cfg.label}
                    </Button>
                );
            })}
        </Box>
    );
}

/**
 * Opens the re-consent flow in a small popup and resolves when the API server's OAuth callback
 * page posts back a `gtd-rsvp-reconsent` message (cleaner and faster than polling `popup.closed`).
 * Falls back to a 500ms close-poll if the message never arrives — covers the popup-blocked
 * navigation fallback and any path where the OAuth flow ends without our finalizer page.
 */
function openReconsentPopup(url: string, onClosed?: () => void): void {
    const popup = window.open(url, 'gtd-reconsent', 'width=480,height=600');
    if (!popup) {
        // Pop-up blocked — fall back to top-level navigation rather than failing silently.
        window.location.href = url;
        return;
    }
    let settled = false;
    const settle = () => {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', onMessage);
        clearInterval(timer);
        onClosed?.();
    };
    const onMessage = (event: MessageEvent) => {
        // Filter on the API origin so a random tab can't trigger settle().
        if (API_SERVER && event.origin !== API_SERVER) return;
        const data = event.data as { type?: string } | null;
        if (data?.type === 'gtd-rsvp-reconsent') {
            settle();
        }
    };
    window.addEventListener('message', onMessage);
    // Fallback poll for closure (popup-blocked top-nav fallback, user-closed-without-finishing).
    const timer = setInterval(() => {
        if (popup.closed) {
            settle();
        }
    }, 500);
}
