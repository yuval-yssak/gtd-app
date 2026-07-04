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
import DialogActions from '@mui/material/DialogActions';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
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
import { useAutosave } from '../../hooks/useAutosave';
import { useCalendarOptions } from '../../hooks/useCalendarOptions';
import { offerUndo } from '../../lib/undoStore';
import type { GCalAttendee, MyDB, StoredItem, StoredPerson, StoredWorkContext } from '../../types/MyDB';
import { AccountPicker } from '../AccountPicker';
import { CalendarFields } from '../clarify/CalendarFields';
import { NextActionFields } from '../clarify/NextActionFields';
import { TicklerDateFields } from '../clarify/TicklerDateFields';
import {
    buildCalendarMeta,
    buildNextActionMeta,
    buildSomedayMaybeMeta,
    buildWaitingForMeta,
    type CalendarFormState,
    type NextActionFormState,
    type SomedayMaybeFormState,
    type WaitingForFormState,
} from '../clarify/types';
import { WaitingForFields } from '../clarify/WaitingForFields';
import {
    applyCalendarPatch,
    buildClarifyToDoneOpts,
    buildEditPatch,
    decideSavePath,
    type EditableStatus,
    type EditorForms,
    type ItemEditorChrome,
    isSaveDisabled,
    mergeFormsIntoItem,
    normalizeTitleAndNotes,
    pickDefaultConfigForUser,
    shouldAutoFocusTitle,
    shouldDetachFromRoutine,
    stripRoutineId,
} from '../editItemDialogLogic';
import { RoutineIndicator } from '../RoutineIndicator';
import { CalendarEventLinks } from './CalendarEventLinks';
import styles from './ItemEditorBody.module.css';
import { itemToCalendarForm, itemToFormSeeds, itemToNextActionForm, itemToSomedayMaybeForm, itemToWaitingForForm, mergeItemForms } from './itemEditorLiveMerge';
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

// Re-exported for callers/tests that historically imported it from here; the implementation moved
// to itemEditorLiveMerge so the merge module never has to import this component (import cycle).
export { itemToCalendarForm } from './itemEditorLiveMerge';

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
    const { loggedInAccounts, routines, items } = useAppData();
    const { runReassignWithOverlay, isPending } = usePendingReassign();
    const reassignInFlight = isPending('item', item._id);

    // Live row — reflects remote sync merges and our own committed autosaves. All persistence
    // paths build on this (never the mount-time `item` prop) so a save can't clobber fields
    // another device changed while the editor was open.
    const liveItem = items.find((i) => i._id === item._id) ?? item;
    const liveItemRef = useRef(liveItem);
    liveItemRef.current = liveItem;

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

    const [naForm, setNaForm] = useState<NextActionFormState>(() => itemToNextActionForm(item));
    const [calForm, setCalForm] = useState<CalendarFormState>(() => itemToCalendarForm(item));
    const visibleCalendarOptions = useMemo(
        () => (ownerUserId === item.userId ? calendarOptions : calendarOptions.filter((opt) => opt.userId === ownerUserId)),
        [calendarOptions, ownerUserId, item.userId],
    );
    const [wfForm, setWfForm] = useState<WaitingForFormState>(() => itemToWaitingForForm(item));
    const [smForm, setSmForm] = useState<SomedayMaybeFormState>(() => itemToSomedayMaybeForm(item));

    // Bundle the per-status forms so the merge/patch builders take one cohesive argument.
    const forms: EditorForms = { na: naForm, cal: calForm, wf: wfForm, sm: smForm };
    const saveDisabled = isSaveDisabled(title, status, calForm) || isSaving;

    // ── Hybrid save model ────────────────────────────────────────────────────
    // Title/notes autosave (debounced, with Undo); everything else (status, schedule, contexts,
    // owner, …) still commits via the explicit Save button. Meetings with attendees are the
    // exception: their title/notes edits stay on explicit Save so the SendUpdatesDialog
    // ("email attendees?") gate keeps intercepting notification-worthy changes.
    const textAutosaveEnabled = (liveItem.attendees?.length ?? 0) === 0;

    // The item values the form state was last seeded/merged from. A form field differing from its
    // seed is "dirty" (user is editing it); the live-merge effect below uses this to decide which
    // fields silently adopt remote changes and which keep local edits.
    const seedFormsRef = useRef(itemToFormSeeds(item));

    // Fields where the user's edit collided with a change from another device. Rendered as a
    // dismissible notice with a whole-form "Use their version" escape hatch.
    const [conflictFields, setConflictFields] = useState<string[]>([]);

    const formRefs = useRef({ title, notes, status, na: naForm, cal: calForm, wf: wfForm, sm: smForm });
    formRefs.current = { title, notes, status, na: naForm, cal: calForm, wf: wfForm, sm: smForm };

    const textAutosave = useAutosave<{ title: string; notes: string }>({
        initial: { title: item.title, notes: item.notes ?? '' },
        commit: async (value, baseline) => {
            if (!value.title.trim()) {
                return; // title is required — never persist a blank one
            }
            await persistTextFields(value);
            offerUndo({
                key: `item:${item._id}:text`,
                message: 'Saved',
                undo: async () => {
                    await persistTextFields(baseline);
                    setTitle(baseline.title);
                    setNotes(baseline.notes);
                    textAutosave.reset(baseline);
                },
                onExpire: () => textAutosave.endBurst(),
            });
        },
    });

    /** Writes the given title/notes onto the LIVE item (raw, untrimmed — trimming here would make
     *  the committed value differ from the form text and re-dirty the controller on every echo). */
    async function persistTextFields(value: { title: string; notes: string }) {
        const live = liveItemRef.current;
        const { notes: _n, ...rest } = live;
        const next: StoredItem = value.notes ? { ...rest, title: value.title, notes: value.notes } : { ...rest, title: value.title };
        const updated = await updateItem(db, next);
        await recordTextExceptionIfRoutineInstance(live, updated);
        await onSaved();
    }

    /** Routine-generated calendar items must record a `modified` exception for title/notes edits,
     *  matching the explicit-save path — otherwise the next series regen clobbers the edit. */
    async function recordTextExceptionIfRoutineInstance(previous: StoredItem, updated: StoredItem) {
        if (updated.status !== 'calendar' || !updated.routineId || !previous.timeStart) {
            return;
        }
        const titleChanged = updated.title !== previous.title;
        const notesChanged = (updated.notes ?? '') !== (previous.notes ?? '');
        if (!titleChanged && !notesChanged) {
            return;
        }
        await recordRoutineInstanceModification(db, updated.routineId, dayjs(previous.timeStart).format('YYYY-MM-DD'), {
            itemId: updated._id,
            ...(titleChanged ? { title: updated.title } : {}),
            ...(notesChanged ? { notes: updated.notes ?? '' } : {}),
        });
    }

    function onTitleChange(nextTitle: string) {
        setTitle(nextTitle);
        if (textAutosaveEnabled) {
            textAutosave.onChange({ title: nextTitle, notes: formRefs.current.notes });
        }
    }

    function onNotesChange(nextNotes: string) {
        setNotes(nextNotes);
        if (textAutosaveEnabled) {
            textAutosave.onChange({ title: formRefs.current.title, notes: nextNotes });
        }
    }

    // ── Live merge ───────────────────────────────────────────────────────────
    // When sync rewrites the open item: clean fields adopt the incoming values; dirty fields keep
    // the local edit and flag a conflict when the remote version changed them differently. Our own
    // autosave echoing back is recognized via the controller's lastCommitted value — not a conflict.
    const lastMergedUpdatedTsRef = useRef(item.updatedTs);
    useEffect(() => {
        // Row identity churns on every unrelated refresh (IDB re-read) — only merge when this
        // item's content actually changed. Every persisted write bumps updatedTs.
        if (liveItem.updatedTs === lastMergedUpdatedTsRef.current) {
            return;
        }
        lastMergedUpdatedTsRef.current = liveItem.updatedTs;
        const seed = seedFormsRef.current;
        const incoming = itemToFormSeeds(liveItem);
        const form = { ...formRefs.current };
        const { merged, conflicts } = mergeItemForms(
            { title: form.title, notes: form.notes, status: form.status, na: form.na, cal: form.cal, wf: form.wf, sm: form.sm },
            seed,
            incoming,
        );
        seedFormsRef.current = incoming;

        // Echo suppression: an incoming text value that equals what our autosave last committed is
        // this editor's own write coming back — never a conflict, even while the user keeps typing.
        const committedText = textAutosave.lastCommitted();
        const realConflicts = conflicts.filter((label) => {
            if (label === 'Title') {
                return incoming.title !== committedText.title;
            }
            if (label === 'Notes') {
                return incoming.notes !== committedText.notes;
            }
            return true;
        });

        setTitle(merged.title);
        setNotes(merged.notes);
        setStatus(merged.status);
        setNaForm(merged.na);
        setCalForm(merged.cal);
        setWfForm(merged.wf);
        setSmForm(merged.sm);
        if (merged.title === incoming.title && merged.notes === incoming.notes) {
            // Text fully clean (or adopted) — tighten the controller baseline to the live values.
            // When text is still dirty we leave the controller alone: its pending commit must
            // survive the merge (a reset would silently drop the user's in-flight burst).
            textAutosave.reset({ title: incoming.title, notes: incoming.notes });
        }
        if (realConflicts.length > 0) {
            setConflictFields((existing) => [...new Set([...existing, ...realConflicts])]);
        }
        // formRefs/textAutosave are stable refs/instances; the effect must run exactly when the
        // live row changes.
    }, [liveItem, textAutosave]);

    /** "Use their version": re-seed the whole form from the live item, dropping local edits. */
    function adoptTheirVersion() {
        const live = liveItemRef.current;
        const seeds = itemToFormSeeds(live);
        seedFormsRef.current = seeds;
        setTitle(seeds.title);
        setNotes(seeds.notes);
        setStatus(seeds.status);
        setNaForm(seeds.na);
        setCalForm(seeds.cal);
        setWfForm(seeds.wf);
        setSmForm(seeds.sm);
        setOwnerUserId(live.userId);
        textAutosave.reset({ title: seeds.title, notes: seeds.notes });
        setConflictFields([]);
    }

    function onSave() {
        if (isSaving) {
            return;
        }
        const trimmedTitle = title.trim();
        if (!trimmedTitle) {
            return;
        }
        const trimmedNotes = notes.trim();
        const live = liveItemRef.current;
        const ownerChanged = ownerUserId !== live.userId;
        const statusChanged = status !== live.status;
        const path = decideSavePath(ownerChanged, statusChanged);
        if (path.kind === 'block') {
            setReassignError(path.error);
            return;
        }
        if (path.kind === 'reassign' && !validateReassign()) {
            return;
        }
        if (path.kind === 'reassign') {
            startReassignInBackground(buildEditPatch(live, trimmedTitle, trimmedNotes, status, forms), trimmedTitle);
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
        const live = liveItemRef.current;
        const ownerChanged = ownerUserId !== live.userId;
        const statusChanged = status !== live.status;
        const path = decideSavePath(ownerChanged, statusChanged);
        startSaving(async () => {
            // Drain any text edit still inside the debounce window first, so its snapshot doesn't
            // land after this save with a newer updatedTs and resurrect pre-save structural fields.
            await textAutosave.flush();
            const base = liveItemRef.current;
            if (path.kind === 'statusTransition') {
                await saveViaStatusTransition(normalizeTitleAndNotes(base, trimmedTitle, trimmedNotes));
            } else {
                await saveInPlace(normalizeTitleAndNotes(base, trimmedTitle, trimmedNotes), gcalMeta);
            }
            offerSaveUndo(base);
            await onSaved();
            onClose();
        });
    }

    /**
     * Undo for the explicit Save: restores the full pre-save snapshot as a new op. Skipped for
     * done/trash transitions on routine-generated items — those disposals already spawned the next
     * routine occurrence, and restoring the old snapshot would leave the series double-booked.
     */
    function offerSaveUndo(beforeSnapshot: StoredItem) {
        const isRoutineDisposal = Boolean(beforeSnapshot.routineId) && (status === 'done' || status === 'trash');
        if (isRoutineDisposal) {
            return;
        }
        offerUndo({
            key: `item:${beforeSnapshot._id}:save`,
            message: 'Item updated',
            undo: async () => {
                await updateItem(db, beforeSnapshot);
                await onSaved();
            },
        });
    }

    /**
     * Decision: do we need to ask the organizer about emailing attendees before saving?
     * Only `inPlace` saves trigger the gate — status transitions and cross-account reassigns route
     * through different server paths that don't currently honour the sidecar.
     */
    function shouldInterceptForSendUpdates(trimmedTitle: string, trimmedNotes: string): boolean {
        if (status !== 'calendar') {
            return false;
        }
        const live = liveItemRef.current;
        const ownerChanged = ownerUserId !== live.userId;
        const statusChanged = status !== live.status;
        const path = decideSavePath(ownerChanged, statusChanged);
        if (path.kind !== 'saveInPlace') {
            return false;
        }
        const merged = mergeFormsIntoItem({ ...live, title: trimmedTitle, notes: trimmedNotes }, status, forms, visibleCalendarOptions);
        // Treat the live attendees state as the post-edit attendee set — attendee-editor changes
        // bypass Save (they queue their own ops) but a parallel title edit still needs the prompt.
        return shouldFireSendUpdatesDialog(
            {
                status: live.status,
                title: live.title,
                notes: live.notes,
                timeStart: live.timeStart,
                timeEnd: live.timeEnd,
                allDay: live.allDay,
                attendees: live.attendees,
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
        if (status !== 'calendar' || !liveItemRef.current.calendarEventId) {
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
                fromUserId: liveItemRef.current.userId,
                toUserId: ownerUserId,
                ...(targetCalendar ? { targetCalendar } : {}),
                ...(hasEdits ? { editPatch } : {}),
            },
        })
            .then(() => onSaved())
            .catch((err) => console.error('[reassign] post-flight refresh failed:', err));
    }

    function resolveTargetCalendar(): { integrationId: string; syncConfigId: string } | null {
        if (status !== 'calendar' || !liveItemRef.current.calendarEventId) {
            return null;
        }
        const targetOption = visibleCalendarOptions.find((opt) => opt.configId === calForm.calendarSyncConfigId);
        if (!targetOption) {
            return null;
        }
        return { integrationId: targetOption.integrationId, syncConfigId: targetOption.configId };
    }

    async function saveInPlace(itemNormalized: StoredItem, gcalMeta: { sendUpdates: 'all' | 'none' } | undefined) {
        const merged = mergeFormsIntoItem(itemNormalized, status, forms, visibleCalendarOptions);
        // Fold in the live attendee state — it lives outside the form because the meeting-details
        // editor mutates it asynchronously and shouldn't be lost on Save. The empty-array case
        // (removing the last attendee) is deliberately NOT handled here: onAttendeesChange persists
        // attendee removals immediately through its own op, and this save rebases off the live row.
        const withAttendees = liveAttendees && liveAttendees.length > 0 ? { ...merged, attendees: liveAttendees } : merged;
        if (gcalMeta) {
            await updateItemWithGcalMeta(db, withAttendees, gcalMeta);
        } else {
            await updateItem(db, withAttendees);
        }
        await maybeRecordRoutineException(withAttendees);
    }

    async function maybeRecordRoutineException(merged: StoredItem) {
        const live = liveItemRef.current;
        if (status !== 'calendar' || !merged.routineId || !live.timeStart) {
            return;
        }
        const timeChanged = merged.timeStart !== live.timeStart || merged.timeEnd !== live.timeEnd;
        const titleChanged = merged.title !== live.title;
        const notesChanged = (merged.notes ?? '') !== (live.notes ?? '');
        if (!timeChanged && !titleChanged && !notesChanged) {
            return;
        }
        const originalDate = dayjs(live.timeStart).format('YYYY-MM-DD');
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
                await clarifyToSomedayMaybe(db, baseItem, buildSomedayMaybeMeta(smForm));
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
        const live = liveItemRef.current;
        if (live.calendarEventId && live.calendarIntegrationId) {
            await queueOfflineRsvp(db, live, {
                responseStatus: nextStatus,
                calendarEventId: live.calendarEventId,
                calendarIntegrationId: live.calendarIntegrationId,
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
        await updateItemAttendees(db, liveItemRef.current, next);
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
            {conflictFields.length > 0 && (
                <Alert
                    severity="info"
                    onClose={() => setConflictFields([])}
                    action={
                        <Button color="inherit" size="small" onClick={adoptTheirVersion} data-testid="itemEditorUseTheirs">
                            Use their version
                        </Button>
                    }
                    data-testid="itemEditorConflictNotice"
                >
                    This item changed on another device ({conflictFields.join(', ')}). Your edits are kept and will overwrite on save.
                </Alert>
            )}
            <TextField
                label="Title"
                value={title}
                onChange={(e) => onTitleChange(e.target.value)}
                onBlur={() => void textAutosave.flush()}
                fullWidth
                required
                {...(shouldAutoFocus ? { autoFocus: true } : {})}
            />

            <NotesSection notes={notes} onNotesChange={onNotesChange} chrome={chrome} />

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

            {liveItem.routineId && (
                <Box data-testid="itemEditorRoutineLink">
                    <RoutineIndicator routineId={liveItem.routineId} routineTitle={routines.find((r) => r._id === liveItem.routineId)?.title} forceChip />
                </Box>
            )}

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
                    <CalendarEventLinks item={liveItem} calendarOptions={calendarOptions} />
                    {((liveAttendees?.length ?? 0) > 0 || item.organizer) && (
                        <MeetingDetails
                            item={{ ...liveItem, ...(liveAttendees ? { attendees: liveAttendees } : {}) }}
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
                <>
                    <Divider />
                    <Stack
                        sx={{
                            gap: 2,
                        }}
                    >
                        <Typography
                            variant="body2"
                            sx={{
                                color: 'text.secondary',
                            }}
                        >
                            Parked for later review. Optionally set a deadline or hide it from review until a date.
                        </Typography>
                        <TicklerDateFields value={smForm} onChange={(patch) => setSmForm((f) => ({ ...f, ...patch }))} />
                    </Stack>
                </>
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
                    if (!pendingSave) {
                        return;
                    }
                    const { trimmedTitle, trimmedNotes } = pendingSave;
                    setPendingSave(null);
                    commitSave(trimmedTitle, trimmedNotes, { sendUpdates });
                }}
                onCancel={() => setPendingSave(null)}
            />
        </Box>
    );
}
