import type { IDBPDatabase } from 'idb';
import { Check, ChevronDown, CircleHelp } from 'lucide-react';
import { useId, useMemo, useState, useTransition } from 'react';
import { API_SERVER } from '../../constants/globals';
import { useAppData } from '../../contexts/AppDataProvider';
import { updatePerson } from '../../db/personMutations';
import {
    AlertDialog,
    Autocomplete,
    Button,
    type ButtonTone,
    Chip,
    type ChipTone,
    Collapsible,
    DialogActions,
    DialogDescription,
    DialogTitle,
    Text,
    TextField,
    Tooltip,
} from '../../designSystem';
import type { GCalAttendee, GCalResponseStatus, MyDB, StoredItem, StoredPerson } from '../../types/MyDB';
import { PersonEditDialog } from '../people/PersonEditDialog';
import { QuickCreatePersonDialog } from '../people/QuickCreatePersonDialog';
import styles from './MeetingDetails.module.css';
import {
    type AttendeeOption,
    addAttendeeByEmail,
    attendeeSuggestions,
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
    /**
     * Read-only projection: renders organizer + attendee chips with no add/remove affordance and no
     * RSVP buttons. Used by the weekly review's routine card, where the panel describes the SERIES
     * master — editing attendees there is a series-wide GCal write that belongs in the routine
     * editor, not in a review glance. `onRsvp`/`onAttendeesChange` are never called in this mode.
     */
    readOnly?: boolean;
    /** Re-consent URL surfaced by the most recent 403 scope_missing RSVP response. */
    scopeMissingReconsentUrl?: string;
    /**
     * Called after the user closes the re-consent popup. The parent should refetch the calendar
     * integrations list and clear `scopeMissingReconsentUrl` so the RSVP buttons re-appear.
     */
    onReconsentClosed?: () => void;
}

const RSVP_BUTTONS: Array<{ status: RsvpStatus; label: string; tone: ButtonTone }> = [
    { status: 'accepted', label: 'Accept', tone: 'success' },
    { status: 'declined', label: 'Decline', tone: 'danger' },
    { status: 'tentative', label: 'Tentative', tone: 'warning' },
];

/**
 * An attendee chip's look for a GCal response status: tinted in the decision's tone, or a neutral
 * outline for `needsAction` so "no answer yet" stays visually distinct from a deliberate decision.
 */
export function chipAppearanceFor(status: GCalResponseStatus): { tone: ChipTone; variant: 'soft' | 'outline' } {
    if (status === 'accepted') return { tone: 'success', variant: 'soft' };
    if (status === 'declined') return { tone: 'error', variant: 'soft' };
    if (status === 'tentative') return { tone: 'warning', variant: 'soft' };
    return { tone: 'neutral', variant: 'outline' };
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
    readOnly = false,
}: MeetingDetailsProps) {
    const { people } = useAppData();
    const [isOpen, setIsOpen] = useState(false);
    const bodyId = useId();
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
        <section className={styles.panel} data-testid="meetingDetails">
            {/* A disclosure, like MUI's Accordion: the header is the toggle, the body collapses. */}
            <button
                type="button"
                className={styles.summary}
                aria-expanded={isOpen}
                aria-controls={bodyId}
                onClick={() => setIsOpen((open) => !open)}
                data-testid="meetingDetailsSummary"
            >
                <span className={styles.summaryHeader}>
                    <Text as="span" variant="bodySm" weight="semibold">
                        {organizer ? `Organizer: ${organizer.displayName ?? organizer.email}` : 'Meeting details'}
                    </Text>
                    {summary && (
                        <Text as="span" variant="caption" tone="secondary">
                            {summary}
                        </Text>
                    )}
                </span>
                <ChevronDown className={styles.summaryIcon} data-open={isOpen || undefined} aria-hidden="true" />
            </button>
            <Collapsible open={isOpen}>
                <div id={bodyId} className={styles.body}>
                    {organizer && (
                        <div className={styles.field}>
                            <Text as="span" variant="caption" tone="secondary">
                                Organizer
                            </Text>
                            <Text variant="bodySm">{organizer.displayName ?? organizer.email}</Text>
                            {showCreator && creator && (
                                <Text as="span" variant="caption" tone="secondary" data-testid="meetingCreator">
                                    Created by {creator.displayName ?? creator.email}
                                </Text>
                            )}
                        </div>
                    )}
                    {readOnly ? (
                        <AttendeesReadOnlyList attendees={attendees} people={people} selfEmail={self?.email} />
                    ) : (
                        <AttendeesEditor
                            db={db}
                            attendees={attendees}
                            people={people}
                            selfEmail={self?.email}
                            ownerUserIdForNewPeople={ownerUserIdForNewPeople ?? item.userId}
                            isRoutineInstance={Boolean(item.routineId)}
                            onAttendeesChange={onAttendeesChange}
                        />
                    )}
                    {!readOnly && self && (
                        <RsvpButtons
                            currentStatus={self.responseStatus}
                            onRsvp={onRsvp}
                            {...(scopeMissingReconsentUrl ? { scopeMissingReconsentUrl } : {})}
                            {...(onReconsentClosed ? { onReconsentClosed } : {})}
                        />
                    )}
                </div>
            </Collapsible>
        </section>
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
        <div className={styles.field}>
            <Text as="span" variant="caption" tone="secondary">
                Attendees
            </Text>
            <div className={styles.attendeesList} data-testid="attendeesList">
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
            </div>
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
                <div className={styles.inlineInputRow} data-testid="addEmailToPersonRow">
                    <Text as="span" variant="caption">
                        Add email for {pendingPersonEmail.person.name}:
                    </Text>
                    <TextField
                        type="email"
                        aria-label={`Email for ${pendingPersonEmail.person.name}`}
                        value={pendingPersonEmail.email}
                        onChange={(e) => setPendingPersonEmail({ person: pendingPersonEmail.person, email: e.target.value })}
                        className={styles.inlineInput}
                        data-testid="addEmailInput"
                    />
                    <Button
                        size="sm"
                        onClick={() => void onCommitPersonWithEmail()}
                        disabled={!isPlausibleEmail(pendingPersonEmail.email)}
                        data-testid="addEmailCommit"
                    >
                        Add
                    </Button>
                    <Button size="sm" tone="neutral" onClick={() => setPendingPersonEmail(null)}>
                        Cancel
                    </Button>
                </div>
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
            {personEditTarget && <PersonEditDialog db={db} person={personEditTarget} onClose={() => setPersonEditTarget(null)} />}
            <AlertDialog open={pendingMutation !== null} onClose={() => setPendingMutation(null)} size="xs">
                <DialogTitle>Detach this occurrence?</DialogTitle>
                <DialogDescription data-testid="detachWarningText">
                    Changing attendees here forks just this date from the recurring event. Future attendee changes on the routine series won't apply to this
                    occurrence.
                </DialogDescription>
                <DialogActions>
                    <Button onClick={() => setPendingMutation(null)} data-testid="detachWarningCancel">
                        Cancel
                    </Button>
                    <Button variant="solid" onClick={() => void onConfirmDetach()} data-testid="detachWarningConfirm">
                        Detach
                    </Button>
                </DialogActions>
            </AlertDialog>
        </div>
    );
}

interface AttendeesReadOnlyListProps {
    attendees: GCalAttendee[];
    people: StoredPerson[];
    selfEmail: string | undefined;
}

/**
 * Non-interactive attendee roster: same chips (RSVP color, person-link check) as the editor, minus
 * the delete icon, the picker and the click-through dialogs. See `MeetingDetailsProps.readOnly`.
 */
function AttendeesReadOnlyList({ attendees, people, selfEmail }: AttendeesReadOnlyListProps) {
    return (
        <div className={styles.field}>
            <Text as="span" variant="caption" tone="secondary">
                Attendees
            </Text>
            <div className={styles.attendeesList} data-testid="attendeesReadOnlyList">
                {attendees.map((attendee) => {
                    const person = findPersonByEmail(people, attendee.email);
                    const label = attendee.displayName ?? attendee.email;
                    const isSelf = Boolean(selfEmail && attendee.email.toLowerCase() === selfEmail.toLowerCase());
                    return (
                        <Tooltip key={attendee.email} title={attendee.email} placement="top">
                            <span>
                                <Chip
                                    label={person ? `${label} ✓` : label}
                                    {...chipAppearanceFor(attendee.responseStatus)}
                                    className={styles.attendeeChip}
                                    data-self={isSelf || undefined}
                                    data-testid={`attendeeReadOnlyChip-${attendee.email}`}
                                />
                            </span>
                        </Tooltip>
                    );
                })}
            </div>
        </div>
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
    const text = person ? `${label} ✓` : label;
    // Click behavior:
    //  - self chip → not interactive.
    //  - unlinked attendee → opens QuickCreatePersonDialog (existing onSaveAsPerson behavior).
    //  - linked attendee → opens PersonEditDialog for that person (symmetric edit affordance).
    // The chip carries a remove button, so the click target is a button inside its label — a chip
    // that is itself a button cannot hold a second one.
    const clickHandler = isSelf ? undefined : person ? () => onEditPerson(person) : onSaveAsPerson;
    return (
        <Tooltip title={attendee.email} placement="top">
            <span>
                <Chip
                    label={
                        clickHandler ? (
                            <button type="button" className={styles.chipLabelButton} onClick={clickHandler} title={person ? 'Edit person' : 'Save as person'}>
                                {text}
                            </button>
                        ) : (
                            text
                        )
                    }
                    {...chipAppearanceFor(attendee.responseStatus)}
                    {...(isSelf ? {} : { onDelete: onRemove, deleteLabel: `Remove ${label}` })}
                    className={styles.attendeeChip}
                    data-self={isSelf || undefined}
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
    // A stable list between keystrokes, so Base UI does not re-sync its items on every render.
    const suggestions = useMemo(() => attendeeSuggestions(people, input), [people, input]);

    function onPicked(option: AttendeeOption) {
        if (option.kind === 'person') {
            onPickPerson(option.person);
        } else {
            onPickEmail(option.newEmail);
        }
        setInput('');
    }

    // Enter on typed text with no suggestion highlighted: commit it if it looks like an email, else ignore.
    function onTextSubmitted(text: string) {
        if (isPlausibleEmail(text)) {
            onPickEmail(text.trim());
            setInput('');
        }
    }

    return (
        <Autocomplete<AttendeeOption>
            aria-label="Add attendee"
            placeholder="Add attendee…"
            inputValue={input}
            onInputValueChange={setInput}
            items={suggestions}
            itemKey={(option) => (option.kind === 'person' ? option.person._id : `new:${option.newEmail}`)}
            itemTestId={(option) => (option.kind === 'person' ? `attendeePickerOption-${option.person._id}` : 'attendeePickerNewEmail')}
            renderItem={(option) => <AttendeeSuggestion option={option} />}
            onItemPicked={onPicked}
            onSubmitText={onTextSubmitted}
            data-testid="attendeePickerInput"
        />
    );
}

function AttendeeSuggestion({ option }: { option: AttendeeOption }) {
    if (option.kind === 'newEmail') {
        return <Text variant="bodySm">Add {option.newEmail}</Text>;
    }
    const { person } = option;
    return (
        <span className={styles.suggestion}>
            <Text as="span" variant="bodySm">
                {person.name}
            </Text>
            {person.email ? (
                <Text as="span" variant="caption" tone="secondary">
                    {person.email}
                </Text>
            ) : (
                <Text as="span" variant="caption" tone="accent">
                    add email →
                </Text>
            )}
        </span>
    );
}

interface RsvpButtonsProps {
    currentStatus: GCalResponseStatus;
    onRsvp: (status: RsvpStatus) => Promise<void>;
    scopeMissingReconsentUrl?: string | undefined;
    onReconsentClosed?: (() => void) | undefined;
}

function RsvpButtons({ currentStatus, onRsvp, scopeMissingReconsentUrl, onReconsentClosed }: RsvpButtonsProps) {
    const [isPending, startRsvp] = useTransition();

    if (scopeMissingReconsentUrl) {
        return (
            <div className={styles.rsvpButtons} data-testid="rsvpReconsent">
                <Tooltip title="Google needs additional permissions before RSVPs can be sent.">
                    <Button variant="solid" onClick={() => openReconsentPopup(scopeMissingReconsentUrl, onReconsentClosed)} data-testid="rsvpReconsentButton">
                        RSVP — authorize
                    </Button>
                </Tooltip>
            </div>
        );
    }

    return (
        <div className={styles.rsvpButtons} data-testid="rsvpButtons">
            {RSVP_BUTTONS.map((cfg) => {
                const isSelected = currentStatus === cfg.status;
                return (
                    <Button
                        key={cfg.status}
                        size="sm"
                        variant={isSelected ? 'solid' : 'outline'}
                        tone={cfg.tone}
                        disabled={isPending}
                        startIcon={isSelected ? <Check /> : <CircleHelp />}
                        aria-pressed={isSelected}
                        onClick={() => startRsvp(async () => await onRsvp(cfg.status))}
                        data-testid={`rsvp-${cfg.status}`}
                    >
                        {cfg.label}
                    </Button>
                );
            })}
        </div>
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
