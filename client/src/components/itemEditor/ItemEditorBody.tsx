import CalendarTodayIcon from '@mui/icons-material/CalendarToday';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import LightbulbOutlinedIcon from '@mui/icons-material/LightbulbOutlined';
import LoopIcon from '@mui/icons-material/Loop';
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
import { createPortal } from 'react-dom';
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
import { offlineReassignMessage } from '../../db/reassignMutations';
import { clarifyToRoutine, undoClarifyToRoutine } from '../../db/routineClarifyMutations';
import { useAutosave } from '../../hooks/useAutosave';
import { useCalendarOptions } from '../../hooks/useCalendarOptions';
import { useEntityUsage } from '../../hooks/useEntityUsage';
import { usePageEscapeToClose } from '../../hooks/usePageEscapeToClose';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import { omitArchived } from '../../lib/entityUsage';
import { isBrowserOffline } from '../../lib/onlineStatus';
import { scopeOptionsToOwner } from '../../lib/ownerScopedPickerOptions';
import { offerUndo } from '../../lib/undoStore';
import type { GCalAttendee, MyDB, StoredItem, StoredPerson, StoredRoutine, StoredWorkContext } from '../../types/MyDB';
import { AccountPicker } from '../AccountPicker';
import { CalendarFields } from '../clarify/CalendarFields';
import { NextActionFields } from '../clarify/NextActionFields';
import { buildRoutineFieldsFromClarify, canClarifyToRoutine, isClarifyToRoutineSaveDisabled, itemToRoutineForm } from '../clarify/routineClarify';
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
    type ClarifyDestination,
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
import { RoutineScheduleFields } from '../routineEditor/RoutineScheduleFields';
import type { FormState as RoutineFormState } from '../routineEditor/routineFormState';
import { UnsavedChangesDialog } from '../UnsavedChangesDialog';
import { CalendarEventLinks } from './CalendarEventLinks';
import { CopyIdButton } from './CopyIdButton';
import styles from './ItemEditorBody.module.css';
import { resolveActionsPlacement } from './itemEditorActionsPlacement';
import {
    isOwnerOrStructurallyEdited,
    itemToCalendarForm,
    itemToFormSeeds,
    itemToNextActionForm,
    itemToSomedayMaybeForm,
    itemToWaitingForForm,
    mergeItemForms,
} from './itemEditorLiveMerge';
import { MeetingDetails, type RsvpStatus } from './MeetingDetails';
import { applyOptimisticRsvp, findSelfAttendee } from './meetingDetailsLogic';
import { NotesSection } from './NotesSection';
import { ReassignInFlightInline } from './ReassignInFlightInline';
import { SendUpdatesDialog } from './SendUpdatesDialog';
import { shouldFireSendUpdatesDialog } from './sendUpdatesDialogLogic';

export type { ItemEditorChrome } from '../editItemDialogLogic';

interface StatusChipConfig {
    value: ClarifyDestination;
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
    // Clarify-only destination: converts the inbox item into a recurring routine (see canClarifyToRoutine).
    { value: 'routine', label: 'Routine', icon: <LoopIcon fontSize="small" /> },
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
    /**
     * True while structural (explicit-save) edits are pending — status, schedule, contexts, owner…
     * Title/notes don't count while text autosave is active (they self-commit). The weekly-review
     * focus card routes its primary action (advance vs. save) on this.
     */
    isDirty: boolean;
    /**
     * The user edited title/notes this editor session. Autosaved text is deliberately excluded
     * from `isDirty` (it commits itself), but hosts whose primary button doubles as an
     * acknowledgement ("Looks good" ↔ "Save & next") still want to reflect the edit. Sticky
     * across the autosave commit (state, not derived); un-flags only if the text is typed back to
     * the CURRENT seed (the last saved/merged text — not necessarily the session's original), and
     * resets on remount (`key={item._id}`) and on "Use their version".
     */
    hasTextEdits: boolean;
    /**
     * True while the selected destination is `routine`. Saving then runs clarify-to-routine — a
     * COMPOUND write (new routine + seeded items + the capture trashed) that a bare snapshot
     * restore cannot reverse, so hosts offering decision undo must not capture one for it.
     */
    isRoutineDestination: boolean;
    onClose: () => void;
}

export interface ItemEditorBodyProps {
    item: StoredItem;
    db: IDBPDatabase<MyDB>;
    /** Picker option pools — scoped to the owner account internally (scopeOptionsToOwner). Callers
     *  that can host an item whose owner account is visibility-hidden (deep-link pages) must pass
     *  the unfiltered all* sets, or the picker degrades to already-assigned strays only. */
    people: StoredPerson[];
    workContexts: StoredWorkContext[];
    onClose: () => void;
    onSaved: () => Promise<void>;
    /**
     * Fired only when an EXPLICIT save commits (triggerSave / Save button, incl. clarify-to-
     * routine), right before the post-save `onClose`. Debounced text autosaves and reassign
     * post-flights fire `onSaved` but never this — hosts that treat "the user saved" as a
     * decision (weekly review) key off this instead of inferring it from `onSaved` timing,
     * which a late autosave flush would corrupt.
     */
    onSaveCommitted?: () => void;
    /**
     * Reactive mirror of `isDirty || isSaving` for host chrome that lives OUTSIDE renderActions
     * and must lock while a structural edit is pending or a save is in flight — e.g. the weekly
     * review's stage-travel arrows, where navigating away is a state change the router-based
     * unsaved-changes guard can never see (so the edit would silently drop). Resets to false on
     * unmount; pass a stable callback (a setState setter) to avoid effect churn.
     */
    onDirtyLockChange?: (isLocked: boolean) => void;
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
    /**
     * Portals the actions row into this element instead of rendering it at the body's end — hosts
     * with a pinned action bar (weekly review) pass the bar element so the buttons stay put while
     * the body scrolls. Pass `null` while the bar's ref hasn't mounted yet; see
     * `resolveActionsPlacement` for the full tri-state semantics.
     */
    actionsContainer?: HTMLElement | null;
    /**
     * The host renders its own CopyIdButton in its header (EditItemDialog, item page), so the
     * meta row skips its copy button to keep exactly one copy affordance per screen — two
     * identical buttons once shipped because distinct testids hid the duplicate. The ID text
     * itself always renders.
     */
    hasHostCopyIdButton?: boolean;
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
    onSaveCommitted,
    onDirtyLockChange,
    onFromGmailReadOnly,
    initialStatus,
    chrome,
    renderActions,
    actionsContainer,
    hasHostCopyIdButton,
}: ItemEditorBodyProps) {
    const { options: calendarOptions } = useCalendarOptions();
    // all* (unfiltered) sets: the live-row lookup and routine-link resolution must keep working
    // when this item's owner account is toggled out of view (editor reached via deep link).
    const { loggedInAccounts, allRoutines, allItems, allWorkContexts, allPeople } = useAppData();
    const { runReassignWithOverlay, isPending } = usePendingReassign();
    const reassignInFlight = isPending('item', item._id);

    // Live row — reflects remote sync merges and our own committed autosaves. All persistence
    // paths build on this (never the mount-time `item` prop) so a save can't clobber fields
    // another device changed while the editor was open.
    const liveItem = allItems.find((i) => i._id === item._id) ?? item;
    const liveItemRef = useRef(liveItem);
    liveItemRef.current = liveItem;

    const [title, setTitle] = useState(item.title);
    const [notes, setNotes] = useState(item.notes ?? '');
    const [status, setStatus] = useState<ClarifyDestination>(initialStatus ?? item.status);
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
    // The routine destination always creates under the item's owner (owner change + routine is
    // blocked), so its calendar picker/link-resolution must never see another account's calendars —
    // resolveCalendarLink's default-fallback would otherwise cross accounts on multi-account devices.
    const routineCalendarOptions = useMemo(() => calendarOptions.filter((opt) => opt.userId === item.userId), [calendarOptions, item.userId]);
    const [wfForm, setWfForm] = useState<WaitingForFormState>(() => itemToWaitingForForm(item));
    const [smForm, setSmForm] = useState<SomedayMaybeFormState>(() => itemToSomedayMaybeForm(item));
    // Routine destination form — the routine editor's own FormState, seeded from the item's
    // metadata. Title/notes stay on this editor's fields and flow in at save time.
    const [routineForm, setRoutineForm] = useState<RoutineFormState>(() => itemToRoutineForm(item));
    // Routine-destination save failures need their own surface: reassignError renders inside
    // AccountPicker, which single-account devices never mount.
    const [routineSaveError, setRoutineSaveError] = useState<string | null>(null);

    // Picker options scoped to the owner account (mirrors visibleCalendarOptions above): the
    // merged multi-account sets would otherwise offer another account's identically-named
    // contexts/people — duplicate "anywhere" chips — and allow cross-account tagging. Archived
    // entities are hidden too, except ids the item already carries (they must stay removable).
    const entityUsage = useEntityUsage();
    // The routine destination has its own contexts/people selection — the picker pools must track
    // whichever form the active destination renders, or its assigned ids degrade to strays.
    const assignedContextIds = status === 'routine' ? routineForm.workContextIds : naForm.workContextIds;
    const pickerWorkContexts = useMemo(
        () =>
            omitArchived(
                scopeOptionsToOwner(workContexts, { ownerUserId, assignedIds: assignedContextIds, allOptions: allWorkContexts }),
                new Set(assignedContextIds),
            ),
        [workContexts, ownerUserId, assignedContextIds, allWorkContexts],
    );
    const assignedPeopleIds = useMemo(
        () => (status === 'routine' ? routineForm.peopleIds : [...naForm.peopleIds, ...(wfForm.waitingForPersonId ? [wfForm.waitingForPersonId] : [])]),
        [status, routineForm.peopleIds, naForm.peopleIds, wfForm.waitingForPersonId],
    );
    const pickerPeople = useMemo(
        () => omitArchived(scopeOptionsToOwner(people, { ownerUserId, assignedIds: assignedPeopleIds, allOptions: allPeople }), new Set(assignedPeopleIds)),
        [people, ownerUserId, assignedPeopleIds, allPeople],
    );

    // Bundle the per-status forms so the merge/patch builders take one cohesive argument.
    const forms: EditorForms = { na: naForm, cal: calForm, wf: wfForm, sm: smForm };
    const saveDisabled = (status === 'routine' ? isClarifyToRoutineSaveDisabled(title, routineForm) : isSaveDisabled(title, status, calForm)) || isSaving;

    // ── Hybrid save model ────────────────────────────────────────────────────
    // Title/notes autosave (debounced, with Undo); everything else (status, schedule, contexts,
    // owner, …) still commits via the explicit Save button. Meetings with attendees are the
    // exception: their title/notes edits stay on explicit Save so the SendUpdatesDialog
    // ("email attendees?") gate keeps intercepting notification-worthy changes.
    const textAutosaveEnabled = (liveItem.attendees?.length ?? 0) === 0;

    // The item values the form state was last seeded/merged from. A form field differing from its
    // seed is "dirty" (user is editing it); the live-merge effect below uses this to decide which
    // fields silently adopt remote changes and which keep local edits. State (not a ref) so the
    // render-time isDirty below is honestly derived; the ref mirror serves the stable callbacks
    // (navigation guard) exactly like formRefs does.
    const [seedForms, setSeedForms] = useState(() => itemToFormSeeds(item));
    const seedFormsRef = useRef(seedForms);
    seedFormsRef.current = seedForms;

    // Fields where the user's edit collided with a change from another device. Rendered as a
    // dismissible notice with a whole-form "Use their version" escape hatch.
    const [conflictFields, setConflictFields] = useState<string[]>([]);

    const formRefs = useRef({ title, notes, status, na: naForm, cal: calForm, wf: wfForm, sm: smForm, ownerUserId });
    formRefs.current = { title, notes, status, na: naForm, cal: calForm, wf: wfForm, sm: smForm, ownerUserId };

    /**
     * Shared structural-dirty core for the render-time `isDirty` and the navigation guard's
     * `hasStructuralEdits()` — see isOwnerOrStructurallyEdited for the remote-reassign nuance.
     * A `routine` destination is always dirty through the status check (an item's status is never
     * 'routine', nor is any initialStatus).
     */
    function isStructurallyEdited(form: typeof formRefs.current, seed: typeof seedForms, liveUserId: string): boolean {
        return isOwnerOrStructurallyEdited({ form, seed, initialStatus, includeText: !textAutosaveEnabled, ownerUserId: form.ownerUserId, liveUserId });
    }

    // Reactive mirror of hasStructuralEdits() for custom action renderers (ItemEditorActionsApi.
    // isDirty) — state-only inputs, no refs. guardBypassRef is deliberately NOT consulted here:
    // it means "a close is in flight, don't prompt", which is orthogonal to what the primary
    // action button should read.
    const isDirty = isStructurallyEdited({ title, notes, status, na: naForm, cal: calForm, wf: wfForm, sm: smForm, ownerUserId }, seedForms, liveItem.userId);

    // See onDirtyLockChange's prop doc. Text edits are deliberately NOT part of the lock — the
    // autosave's unmount flush commits them, so navigating away can't lose them.
    useEffect(() => {
        onDirtyLockChange?.(isDirty || isSaving);
    }, [isDirty, isSaving, onDirtyLockChange]);
    useEffect(() => () => onDirtyLockChange?.(false), [onDirtyLockChange]);

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

    // Text-edit marker for ItemEditorActionsApi.hasTextEdits. Compared against the current seed
    // (not blindly latched) so typing text back to its saved value un-flags it; once an autosave
    // commit re-seeds, the flag stays put in state — the acknowledgement survives the commit.
    const [hasTextEdits, setHasTextEdits] = useState(false);

    function onTitleChange(nextTitle: string) {
        setTitle(nextTitle);
        setHasTextEdits(nextTitle !== seedForms.title || formRefs.current.notes !== seedForms.notes);
        if (textAutosaveEnabled) {
            textAutosave.onChange({ title: nextTitle, notes: formRefs.current.notes });
        }
    }

    function onNotesChange(nextNotes: string) {
        setNotes(nextNotes);
        setHasTextEdits(formRefs.current.title !== seedForms.title || nextNotes !== seedForms.notes);
        if (textAutosaveEnabled) {
            textAutosave.onChange({ title: formRefs.current.title, notes: nextNotes });
        }
    }

    // ── Unsaved-changes guard ────────────────────────────────────────────────
    // Structural edits (status, schedule, contexts, owner, …) only persist on explicit Save, so
    // navigating away or reloading would silently drop them. Pause in-app navigations behind a
    // confirm dialog and arm the native beforeunload prompt while such edits exist.
    const guardBypassRef = useRef(false);

    /** Deliberate close (Cancel, post-save, wizard skip) — the navigation it triggers must never
     *  re-prompt about the edits the user just chose to discard or already saved. */
    function closeEditor() {
        guardBypassRef.current = true;
        onClose();
    }

    function hasStructuralEdits(): boolean {
        if (guardBypassRef.current) {
            return false;
        }
        return isStructurallyEdited(formRefs.current, seedFormsRef.current, liveItemRef.current.userId);
    }

    const navigationBlocker = useUnsavedChangesGuard({
        hasUnsavedChanges: hasStructuralEdits,
        // A hard unload also kills a debounced text commit mid-window — the unmount flush that
        // covers in-app navigation never runs on reload/close.
        hasUnsavedChangesOnUnload: () => hasStructuralEdits() || textAutosave.isDirty(),
    });

    // Page chrome only — the other chromes get ESC from MUI Modal. Deliberately the raw `onClose`
    // (not closeEditor): the resulting router navigation must stay behind the guard above, exactly
    // like the header's back arrow.
    usePageEscapeToClose({ enabled: chrome === 'page', onEscape: onClose });

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
        setSeedForms(incoming);

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
        setSeedForms(seeds);
        setTitle(seeds.title);
        setNotes(seeds.notes);
        setStatus(seeds.status);
        setNaForm(seeds.na);
        setCalForm(seeds.cal);
        setWfForm(seeds.wf);
        setSmForm(seeds.sm);
        setOwnerUserId(live.userId);
        textAutosave.reset({ title: seeds.title, notes: seeds.notes });
        setHasTextEdits(false); // the discarded local edits no longer warrant a "Save & next" acknowledgement
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
        // Routine is a clarify-only destination with its own commit path — the item is consumed
        // (trashed) and a routine is born, rather than the item transitioning status. Reached only
        // without an owner change: status !== live.status always holds here, so an owner change
        // lands in the `block` branch above.
        if (status === 'routine') {
            // Re-validate against the LIVE item: a remote sync may have clarified it (or attached
            // it to a routine) while this editor held a dirty 'routine' selection — the chip is
            // gone from the row, but the local status survives the live merge.
            if (!canClarifyToRoutine(live)) {
                setRoutineSaveError('This item changed on another device and is no longer an inbox capture. Pick a different status.');
                return;
            }
            setReassignError(null);
            setRoutineSaveError(null);
            commitClarifyToRoutine(trimmedTitle, trimmedNotes);
            return;
        }
        if (path.kind === 'reassign' && !validateReassign()) {
            return;
        }
        if (path.kind === 'reassign') {
            // Block BEFORE closeEditor — the edit patch only lives in this mount's form state, so
            // closing on a doomed offline reassign would silently discard every pending edit.
            if (isBrowserOffline()) {
                setReassignError(offlineReassignMessage(trimmedTitle));
                return;
            }
            startReassignInBackground(buildEditPatch(live, trimmedTitle, trimmedNotes, status, forms), trimmedTitle);
            closeEditor();
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
            onSaveCommitted?.();
            closeEditor();
        });
    }

    function commitClarifyToRoutine(trimmedTitle: string, trimmedNotes: string) {
        startSaving(async () => {
            // Drain any text edit still inside the debounce window first — same rationale as
            // commitSave: a late snapshot with a newer updatedTs would resurrect the trashed item.
            await textAutosave.flush();
            const normalized = normalizeTitleAndNotes(liveItemRef.current, trimmedTitle, trimmedNotes);
            try {
                const { routine } = await clarifyToRoutine(db, normalized, buildRoutineFieldsFromClarify(normalized, routineForm, routineCalendarOptions));
                offerClarifyToRoutineUndo(normalized, routine);
            } catch (err) {
                // clarifyToRoutine creates the routine BEFORE trashing the item, so on failure the
                // capture is intact — keep the editor open with an actionable error instead of
                // silently re-enabling the Save button.
                console.error('[clarify-to-routine] failed:', err);
                setRoutineSaveError('Could not create the routine. Your item was not changed.');
                return;
            }
            await onSaved();
            onSaveCommitted?.();
            closeEditor();
        });
    }

    /**
     * Undo for clarify-to-routine: restores the pre-clarify item AND deletes the just-created
     * routine (plus everything it generated). Skipped when the item itself was routine-generated —
     * trashing it advanced the OLD routine's series, which a snapshot restore can't reverse (same
     * rule as offerSaveUndo's routine-disposal guard).
     */
    function offerClarifyToRoutineUndo(beforeSnapshot: StoredItem, routine: StoredRoutine) {
        if (beforeSnapshot.routineId) {
            return;
        }
        offerUndo({
            key: `item:${beforeSnapshot._id}:save`,
            message: 'Routine created',
            link: `/routine/${routine._id}`,
            undo: async () => {
                await undoClarifyToRoutine(db, routine, beforeSnapshot);
                await onSaved();
            },
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
            // Editor closes on save (e.g. after clarifying an inbox item) — offer a jump back to it.
            link: `/item/${beforeSnapshot._id}`,
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
            // Only fire the success postlude on a confirmed move — a blocked/failed reassign
            // already showed its snackbar, and onSaved would advance wizard flows as if it worked.
            .then((didMove) => (didMove ? onSaved() : undefined))
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
                <ReassignInFlightInline onClose={closeEditor} />
            </Box>
        );
    }

    const shouldAutoFocus = shouldAutoFocusTitle(chrome, initialStatus);

    const actionButtons = renderActions ? (
        renderActions({ triggerSave: onSave, saveDisabled, isSaving, isDirty, hasTextEdits, isRoutineDestination: status === 'routine', onClose: closeEditor })
    ) : (
        <>
            <Button onClick={closeEditor}>Cancel</Button>
            <Button variant="contained" disabled={saveDisabled} onClick={() => onSave()}>
                Save changes
            </Button>
        </>
    );
    const actionsRow =
        chrome === 'dialog' ? <DialogActions sx={{ px: 0 }}>{actionButtons}</DialogActions> : <Box className={styles.inlineActions}>{actionButtons}</Box>;
    const actionsPlacement = resolveActionsPlacement(actionsContainer);

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

            {status === 'calendar' && (
                <CalendarFields
                    value={calForm}
                    onChange={(patch) => setCalForm((f) => applyCalendarPatch(f, patch))}
                    calendarOptions={visibleCalendarOptions}
                    forceShowPicker={ownerUserId !== item.userId}
                />
            )}

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
                    {STATUS_CHIPS.filter((cfg) => cfg.value !== 'routine' || canClarifyToRoutine(liveItem)).map((cfg) => (
                        <Chip
                            key={cfg.value}
                            icon={cfg.icon}
                            label={cfg.label}
                            variant={status === cfg.value ? 'filled' : 'outlined'}
                            color={status === cfg.value ? (cfg.color ?? 'primary') : 'default'}
                            onClick={() => {
                                setRoutineSaveError(null);
                                setStatus(cfg.value);
                            }}
                        />
                    ))}
                </Stack>
            </Box>

            {liveItem.routineId && (
                <Box data-testid="itemEditorRoutineLink">
                    <RoutineIndicator routineId={liveItem.routineId} routineTitle={allRoutines.find((r) => r._id === liveItem.routineId)?.title} forceChip />
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
                    <NextActionFields
                        value={naForm}
                        onChange={(patch) => setNaForm((f) => ({ ...f, ...patch }))}
                        workContexts={pickerWorkContexts}
                        people={pickerPeople}
                        usage={entityUsage}
                    />
                </>
            )}

            {status === 'calendar' && (
                <>
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
                    <WaitingForFields value={wfForm} onChange={(patch) => setWfForm((f) => ({ ...f, ...patch }))} people={pickerPeople} />
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

            {status === 'routine' && (
                <>
                    <Divider />
                    <Stack
                        sx={{
                            gap: 2,
                        }}
                        data-testid="itemEditorRoutineFields"
                    >
                        <Typography
                            variant="body2"
                            sx={{
                                color: 'text.secondary',
                            }}
                        >
                            Turns this item into a repeating routine. The item itself is consumed — the routine takes its title and notes.
                        </Typography>
                        {routineSaveError && (
                            <Alert severity="error" data-testid="itemEditorRoutineSaveError">
                                {routineSaveError}
                            </Alert>
                        )}
                        <RoutineScheduleFields
                            form={routineForm}
                            onPatch={(patch) => setRoutineForm((f) => ({ ...f, ...patch }))}
                            calendarOptions={routineCalendarOptions}
                            workContexts={pickerWorkContexts}
                            people={pickerPeople}
                            usage={entityUsage}
                            frequencyKey={item._id}
                        />
                    </Stack>
                </>
            )}

            <Divider />

            <Box className={styles.metaRow}>
                <Typography
                    variant="caption"
                    data-testid="itemEditorCreatedAt"
                    sx={{
                        color: 'text.secondary',
                    }}
                >
                    Created {dayjs(liveItem.createdTs).format('MMM D, YYYY h:mm A')}
                </Typography>
                <Typography
                    variant="caption"
                    className={styles.itemId}
                    data-testid="itemEditorId"
                    sx={{
                        color: 'text.secondary',
                    }}
                >
                    ID {item._id}
                </Typography>
                {/* The shared hardened button (tooltip + failure snackbar). Hosts with their own
                    header CopyIdButton suppress this one so exactly one shows per screen. */}
                {!hasHostCopyIdButton && <CopyIdButton id={item._id} />}
            </Box>

            {actionsPlacement.kind === 'inline' && actionsRow}
            {actionsPlacement.kind === 'portal' && createPortal(actionsRow, actionsPlacement.container)}
            <UnsavedChangesDialog blocker={navigationBlocker} />
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
