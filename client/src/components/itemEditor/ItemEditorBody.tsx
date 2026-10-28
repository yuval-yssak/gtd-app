import { clsx } from 'clsx';
import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { CalendarDays, CircleCheck, Hourglass, Inbox, Lightbulb, Play, Repeat, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { createPortal } from 'react-dom';
import { type RsvpPushStatus, rsvpOnline } from '../../api/calendarApi';
import type { ReassignItemEditPatch } from '../../api/syncApi';
import { useAppData } from '../../contexts/AppDataProvider';
import { usePendingReassign } from '../../contexts/PendingReassignProvider';
import { dispatchOpFlush } from '../../db/dispatchOpFlush';
import { clearBrief, setUserBrief } from '../../db/itemBriefMutations';
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
import { Button, Callout, Chip, type ChipTone, Separator, Text, TextField, Tooltip } from '../../designSystem';
import { useAutosave } from '../../hooks/useAutosave';
import { useCalendarOptions } from '../../hooks/useCalendarOptions';
import { EDITOR_KEY_SCOPE_ATTR, useEditorShortcuts } from '../../hooks/useEditorShortcuts';
import { useEntityUsage } from '../../hooks/useEntityUsage';
import { usePageEscapeToClose } from '../../hooks/usePageEscapeToClose';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import { useShowBriefs } from '../../lib/briefPreference';
import { briefState } from '../../lib/briefSource';
import { statusKeyOf } from '../../lib/editorShortcuts';
import { omitArchived } from '../../lib/entityUsage';
import { startsOnFutureDay } from '../../lib/futureDoneConfirm';
import { isBrowserOffline } from '../../lib/onlineStatus';
import { scopeOptionsToOwner } from '../../lib/ownerScopedPickerOptions';
import { chordLabel, isApplePlatform } from '../../lib/platformKeys';
import { rankSectionKeyOf } from '../../lib/rankSections';
import { withShortcutHint } from '../../lib/rowShortcuts';
import { collapseToSingleLine } from '../../lib/singleLineText';
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
import { DisabledCapableTooltip } from '../DisabledCapableTooltip';
import { buildDoneContextLookups, doneItemContext } from '../doneItemContextLogic';
import { FutureDoneConfirmDialog, useFutureDoneConfirm } from '../FutureDoneConfirmDialog';
import { NextActionPositionRow } from '../nextActions/NextActionPositionRow';
import { RoutineIndicator } from '../RoutineIndicator';
import { RoutineScheduleFields } from '../routineEditor/RoutineScheduleFields';
import type { FormState as RoutineFormState } from '../routineEditor/routineFormState';
import { UnsavedChangesDialog } from '../UnsavedChangesDialog';
import { BriefSection } from './BriefSection';
import { decideBriefCommit, type EditorPresentation, isBriefableItemStatus, isBriefFirst } from './briefSectionLogic';
import { CalendarEventLinks } from './CalendarEventLinks';
import { CopyIdButton } from './CopyIdButton';
import { DoneItemContextSection } from './DoneItemContextSection';
import styles from './ItemEditorBody.module.css';
import { resolveActionsPlacement } from './itemEditorActionsPlacement';
import {
    applyGroupMergeOutcome,
    applyMergeOutcome,
    briefTextOf,
    isOwnerOrStructurallyEdited,
    itemToCalendarForm,
    itemToFormSeeds,
    itemToNextActionForm,
    itemToSomedayMaybeForm,
    itemToWaitingForForm,
    mergeItemForms,
} from './itemEditorLiveMerge';
import {
    applyCalendarPatch,
    buildClarifyToDoneOpts,
    buildEditPatch,
    type ClarifyDestination,
    decideSavePath,
    type EditableStatus,
    type EditorForms,
    isSaveDisabled,
    mergeFormsIntoItem,
    normalizeTitleAndNotes,
    pickDefaultConfigForUser,
    shouldDetachFromRoutine,
    stripRoutineId,
} from './itemEditorLogic';
import { MeetingDetails, type RsvpStatus } from './MeetingDetails';
import { applyOptimisticRsvp, findSelfAttendee } from './meetingDetailsLogic';
import { NotesSection } from './NotesSection';
import { ReassignInFlightInline } from './ReassignInFlightInline';
import { SendUpdatesDialog } from './SendUpdatesDialog';
import { shouldFireSendUpdatesDialog } from './sendUpdatesDialogLogic';
import { useBriefGeneration } from './useBriefGeneration';

interface StatusChipConfig {
    value: ClarifyDestination;
    label: string;
    icon: React.ReactElement;
    /** The chip's fill while selected; accent when omitted. */
    tone?: ChipTone;
}

const STATUS_CHIPS: StatusChipConfig[] = [
    { value: 'inbox', label: 'Inbox', icon: <Inbox /> },
    { value: 'nextAction', label: 'Next Action', icon: <Play /> },
    { value: 'calendar', label: 'Calendar', icon: <CalendarDays /> },
    { value: 'waitingFor', label: 'Waiting For', icon: <Hourglass /> },
    { value: 'somedayMaybe', label: 'Someday / Maybe', icon: <Lightbulb /> },
    // Clarify-only destination: converts the inbox item into a recurring routine (see canClarifyToRoutine).
    { value: 'routine', label: 'Routine', icon: <Repeat /> },
    { value: 'done', label: 'Done', icon: <CircleCheck />, tone: 'success' },
    { value: 'trash', label: 'Trash', icon: <Trash2 />, tone: 'error' },
];

/** A status chip's tooltip: its label, plus its letter when it has one. */
function chipTitle(cfg: StatusChipConfig): string {
    const key = statusKeyOf(cfg.value);
    return key ? withShortcutHint(cfg.label, key) : cfg.label;
}

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
     * would normally push to GCal. The body has no toast of its own — the host wires this to its
     * page toast (useItemEditor's `onFromGmailReadOnly`) so the warning surfaces there.
     */
    onFromGmailReadOnly?: () => void;
    /** Pre-selects the status chip on open. When omitted, defaults to item.status. */
    initialStatus?: EditableStatus;
    /**
     * `review` (weekly-review cards): when the item has a brief on show, the card leads with the
     * brief line and folds the notes behind "Show notes". Presentation only — same editor, same
     * save paths. Default `edit` renders the brief as a plain field under the title.
     */
    presentation?: EditorPresentation;
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
     * The host renders its own CopyIdButton in its header (the item page), so the
     * meta row skips its copy button to keep exactly one copy affordance per screen — two
     * identical buttons once shipped because distinct testids hid the duplicate. The ID text
     * itself always renders.
     */
    hasHostCopyIdButton?: boolean;
    /**
     * `false` keeps title/notes edits on the explicit Save path, as for meetings with attendees.
     * The review's collapsed routine card needs it: an autosaved edit records a routine exception,
     * which re-shapes the review queue under the card while the user is still typing.
     */
    isTextAutosaveAllowed?: boolean;
}

// Re-exported for callers/tests that historically imported it from here; the implementation moved
// to itemEditorLiveMerge so the merge module never has to import this component (import cycle).
export { itemToCalendarForm } from './itemEditorLiveMerge';

/**
 * Live-merge trigger key. The brief row has its own LWW anchor, so its updatedTs joins the item's:
 * a brief that arrives (or is deleted) without any item change must still merge into the open editor.
 */
function mergeKeyOf(itemTs: string, briefTs: string | undefined): string {
    return `${itemTs}|${briefTs ?? ''}`;
}

/** Resolves the body's props. The review presentation flags a density modifier on top of the bare
 *  flex column (tighter section gap, no notes-preview height floor). */
export function bodyPropsFor(presentation: EditorPresentation) {
    return { className: styles.body, 'data-review': presentation === 'review' || undefined };
}

/**
 * Unified item editor body — owns all state, save logic, and the per-status forms. Hosts (the item
 * page, the Process Inbox wizard, the weekly review cards) supply only the surrounding container.
 *
 * Hosts MUST set `key={item._id}` so React remounts the body when the editor opens on a
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
    presentation = 'edit',
    renderActions,
    actionsContainer,
    hasHostCopyIdButton,
    isTextAutosaveAllowed = true,
}: ItemEditorBodyProps) {
    const { options: calendarOptions } = useCalendarOptions();
    // all* (unfiltered) sets: the live-row lookup and routine-link resolution must keep working
    // when this item's owner account is toggled out of view (editor reached via deep link).
    const { loggedInAccounts, allRoutines, allItems, allWorkContexts, allPeople, allItemBriefs, refreshItemBriefs } = useAppData();
    const { runReassignWithOverlay, isPending } = usePendingReassign();
    const reassignInFlight = isPending('item', item._id);

    // Live row — reflects remote sync merges and our own committed autosaves. All persistence
    // paths build on this (never the mount-time `item` prop) so a save can't clobber fields
    // another device changed while the editor was open.
    const liveItem = allItems.find((i) => i._id === item._id) ?? item;
    const liveItemRef = useRef(liveItem);
    liveItemRef.current = liveItem;
    // The brief sidecar row (`_id === item._id`) — resolved from the provider's snapshot, never a
    // per-render IDB read. Same live-row discipline as `liveItem`.
    const liveBrief = allItemBriefs.find((row) => row._id === item._id);
    const liveBriefRef = useRef(liveBrief);
    liveBriefRef.current = liveBrief;
    // Hook order: must sit above the reassign-in-flight early return below. `flushItemText` goes
    // through a ref because `textAutosave` is created further down (it needs the form state).
    const flushItemTextRef = useRef(async () => {});
    const flushItemTextLocallyRef = useRef(async () => {});
    const briefGeneration = useBriefGeneration(db, { item: liveItem, brief: liveBrief, flushItemText: () => flushItemTextRef.current() });

    const [title, setTitle] = useState(item.title);
    const [notes, setNotes] = useState(item.notes ?? '');
    const [brief, setBrief] = useState(() => briefTextOf(liveBrief));
    const isShowBriefsOn = useShowBriefs();
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
    const futureDone = useFutureDoneConfirm([liveItem]);

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
    // By id across accounts, like the pickers' `allOptions`: a done item may reference an archived entity.
    const doneContextLookups = useMemo(() => buildDoneContextLookups(allPeople, allWorkContexts), [allPeople, allWorkContexts]);
    const doneContext = useMemo(() => doneItemContext(liveItem, doneContextLookups), [liveItem, doneContextLookups]);

    // Bundle the per-status forms so the merge/patch builders take one cohesive argument.
    const forms: EditorForms = { na: naForm, cal: calForm, wf: wfForm, sm: smForm };
    const saveDisabled = (status === 'routine' ? isClarifyToRoutineSaveDisabled(title, routineForm) : isSaveDisabled(title, status, calForm)) || isSaving;

    // ── Hybrid save model ────────────────────────────────────────────────────
    // Title/notes autosave (debounced, with Undo); everything else (status, schedule, contexts,
    // owner, …) still commits via the explicit Save button. Meetings with attendees are the
    // exception: their title/notes edits stay on explicit Save so the SendUpdatesDialog
    // ("email attendees?") gate keeps intercepting notification-worthy changes. A host that opts
    // out (`isTextAutosaveAllowed={false}`) keeps text edits on explicit Save too.
    const textAutosaveEnabled = isTextAutosaveAllowed && (liveItem.attendees?.length ?? 0) === 0;

    // The item values the form state was last seeded/merged from. A form field differing from its
    // seed is "dirty" (user is editing it); the live-merge effect below uses this to decide which
    // fields silently adopt remote changes and which keep local edits. State (not a ref) so the
    // render-time isDirty below is honestly derived; the ref mirror serves the stable callbacks
    // (navigation guard) exactly like formRefs does.
    const [seedForms, setSeedForms] = useState(() => itemToFormSeeds(item, liveBrief));
    const seedFormsRef = useRef(seedForms);
    seedFormsRef.current = seedForms;

    // Fields where the user's edit collided with a change from another device. Rendered as a
    // dismissible notice with a whole-form "Use their version" escape hatch.
    const [conflictFields, setConflictFields] = useState<string[]>([]);

    const formRefs = useRef({ title, notes, brief, status, na: naForm, cal: calForm, wf: wfForm, sm: smForm, ownerUserId });
    formRefs.current = { title, notes, brief, status, na: naForm, cal: calForm, wf: wfForm, sm: smForm, ownerUserId };

    /**
     * A user edit writes the ref THROUGH before setting state: the live-merge effect can run before
     * the next render (an autosave echo landing in the same tick as a keystroke or a status letter),
     * and must merge against what the user has, not the last render's snapshot — or it rebaselines
     * the autosave over an unsaved keystroke and misses a conflict.
     */
    function writeFormField<K extends keyof typeof formRefs.current>(key: K, value: (typeof formRefs.current)[K], commit: (next: typeof value) => void) {
        formRefs.current = { ...formRefs.current, [key]: value };
        commit(value);
    }

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
    const isDirty = isStructurallyEdited(
        { title, notes, brief, status, na: naForm, cal: calForm, wf: wfForm, sm: smForm, ownerUserId },
        seedForms,
        liveItem.userId,
    );

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

    function onTitleChange(rawTitle: string) {
        // The field wraps (multiline) so a pasted newline would otherwise survive into the stored
        // title, which is a single-line value everywhere it is shown. Typed Enter is swallowed by
        // the field's own onKeyDown; this covers paste, drop and autofill.
        const nextTitle = collapseToSingleLine(rawTitle);
        writeFormField('title', nextTitle, setTitle);
        setHasTextEdits(nextTitle !== seedForms.title || formRefs.current.notes !== seedForms.notes);
        if (textAutosaveEnabled) {
            textAutosave.onChange({ title: nextTitle, notes: formRefs.current.notes });
        }
    }

    function onNotesChange(nextNotes: string) {
        writeFormField('notes', nextNotes, setNotes);
        setHasTextEdits(formRefs.current.title !== seedForms.title || nextNotes !== seedForms.notes);
        if (textAutosaveEnabled) {
            textAutosave.onChange({ title: formRefs.current.title, notes: nextNotes });
        }
    }

    // Generate-brief precondition: commit the debounced title/notes and push the queued op to
    // the server, so the model reads the text the user sees (NotesSection's blur does not flush).
    // dispatchOpFlush, not waitForPendingFlush: queueSyncOp's fire-and-forget dispatch has not
    // started its flush yet at this point (it first awaits an IDB read), so waiting on an
    // in-flight flush would resolve immediately with the op still queued. The dispatch awaits the
    // actual push — joining a flush already running — and pivots to the owner's session for a
    // cross-account item.
    flushItemTextRef.current = async () => {
        await textAutosave.flush();
        await dispatchOpFlush(db, liveItemRef.current.userId);
    };
    // The LOCAL half only: the Position row needs the pending text written to IDB before it
    // re-keys the row (an autosave firing between the two writes would put the old rank back),
    // but must never wait on — or fail with — the network push; a reorder is an offline write.
    flushItemTextLocallyRef.current = () => textAutosave.flush();

    // ── Brief (sidecar entity, its own op) ───────────────────────────────────
    // Saves on blur/Enter/clear and on unmount (like the text autosave's unmount flush). The last
    // value THIS editor wrote is remembered so its echo through sync never reads as a conflict.
    const lastCommittedBriefRef = useRef(briefTextOf(liveBrief));
    // `fieldValue` is passed in rather than read from formRefs: the clear button changes and
    // commits in one tick, before the state (and so the ref mirror) has re-rendered.
    async function commitBrief(fieldValue: string) {
        const decision = decideBriefCommit(fieldValue, seedFormsRef.current.brief);
        if (decision.kind === 'noop') {
            return;
        }
        const committedText = decision.kind === 'set' ? decision.text : '';
        lastCommittedBriefRef.current = committedText;
        setBrief(committedText);
        // Rebaseline the seed locally NOW: the merge effect only re-seeds once the refreshed row
        // has round-tripped through the provider, and a blur/Enter pair (or a second blur) inside
        // that window would otherwise re-queue the same value as a fresh op.
        setSeedForms((prev) => ({ ...prev, brief: committedText }));
        await (decision.kind === 'set' ? setUserBrief(db, liveItemRef.current, decision.text) : clearBrief(db, item._id));
        await refreshItemBriefs();
    }
    const commitBriefRef = useRef(commitBrief);
    commitBriefRef.current = commitBrief;
    const flushBrief = (fieldValue: string) => commitBriefRef.current(fieldValue).catch((e) => console.warn('[brief] failed to save brief', e));
    const flushBriefRef = useRef(flushBrief);
    flushBriefRef.current = flushBrief;
    // Unmount flush: the field's blur never fires when the host unmounts the editor (Escape,
    // wizard advance), so a brief typed right before leaving would otherwise be lost. StrictMode-
    // safe without a guard: the spurious first cleanup sees form === seed and decides `noop`.
    useEffect(() => () => void flushBriefRef.current(formRefs.current.brief), []);

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

    // Deliberately the raw `onClose` (not closeEditor): on a route host the resulting navigation stays
    // behind the guard above, exactly like the header's back arrow. Inline hosts (review card, Process
    // Inbox wizard) close without navigating, so they own the discard decision themselves.
    usePageEscapeToClose({ enabled: true, onEscape: onClose });

    // ── Live merge ───────────────────────────────────────────────────────────
    // When sync rewrites the open item: clean fields adopt the incoming values; dirty fields keep
    // the local edit and flag a conflict when the remote version changed them differently. Our own
    // autosave echoing back is recognized via the controller's lastCommitted value — not a conflict.
    const lastMergedKeyRef = useRef(mergeKeyOf(item.updatedTs, liveBrief?.updatedTs));
    useEffect(() => {
        // Row identity churns on every unrelated refresh (IDB re-read) — only merge when this
        // item's (or its brief's) content actually changed. Every persisted write bumps updatedTs.
        const mergeKey = mergeKeyOf(liveItem.updatedTs, liveBrief?.updatedTs);
        if (mergeKey === lastMergedKeyRef.current) {
            return;
        }
        lastMergedKeyRef.current = mergeKey;
        const seed = seedFormsRef.current;
        const incoming = itemToFormSeeds(liveItem, liveBrief);
        const form = { ...formRefs.current };
        const { merged, conflicts } = mergeItemForms(
            { title: form.title, notes: form.notes, brief: form.brief, status: form.status, na: form.na, cal: form.cal, wf: form.wf, sm: form.sm },
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
            if (label === 'Brief') {
                return incoming.brief !== lastCommittedBriefRef.current;
            }
            return true;
        });

        // Functional updates over the CURRENT state, as a safeguard behind the write-through refs
        // (writeFormField): only what the merge adopted is written, never a copy of `form` itself.
        setTitle((current) => applyMergeOutcome(current, { snapshot: form.title, merged: merged.title }));
        setNotes((current) => applyMergeOutcome(current, { snapshot: form.notes, merged: merged.notes }));
        setBrief((current) => applyMergeOutcome(current, { snapshot: form.brief, merged: merged.brief }));
        setStatus((current) => applyMergeOutcome(current, { snapshot: form.status, merged: merged.status }));
        setNaForm((current) => applyGroupMergeOutcome(current, { snapshot: form.na, merged: merged.na }));
        setCalForm((current) => applyGroupMergeOutcome(current, { snapshot: form.cal, merged: merged.cal }));
        setWfForm((current) => applyGroupMergeOutcome(current, { snapshot: form.wf, merged: merged.wf }));
        setSmForm((current) => applyGroupMergeOutcome(current, { snapshot: form.sm, merged: merged.sm }));
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
        // live row (or its brief row) changes.
    }, [liveItem, liveBrief, textAutosave]);

    /** "Use their version": re-seed the whole form from the live item, dropping local edits. */
    function adoptTheirVersion() {
        const live = liveItemRef.current;
        const seeds = itemToFormSeeds(live, liveBriefRef.current);
        setSeedForms(seeds);
        setTitle(seeds.title);
        setNotes(seeds.notes);
        setBrief(seeds.brief);
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
        // Completing a calendar item that starts on a later day asks first. Such a save is always a
        // plain calendar→done status transition (no reassign, no attendee prompt), so the confirm
        // resumes straight at the commit.
        if (status === 'done' && startsOnFutureDay(live)) {
            futureDone.confirmDone(live, () => commitSave(trimmedTitle, trimmedNotes, undefined));
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

    // Keyboard: Cmd/Ctrl+Enter saves; outside a text field a letter picks a status chip and
    // Alt(⌥)+arrows move the item in its list (lib/editorShortcuts.ts).
    const isApple = useMemo(isApplePlatform, []);
    const onEditorKeyDown = useEditorShortcuts({
        onSave: () => onSave(),
        // A host with its own actions (Weekly Review, the Process Inbox wizard) runs its own save
        // handshake (decision + undo capture) around `triggerSave`: a body-level Cmd/Ctrl+Enter would
        // bypass it, so the shortcut is off there.
        isSaveDisabled: saveDisabled || renderActions !== undefined,
        onPickStatus: (next) => {
            setRoutineSaveError(null);
            writeFormField('status', next, setStatus);
        },
        canPick: (next) => next !== 'routine' || canClarifyToRoutine(liveItem),
    });

    if (reassignInFlight) {
        return (
            <div {...bodyPropsFor(presentation)}>
                <ReassignInFlightInline onClose={closeEditor} />
            </div>
        );
    }

    const briefRowState = briefState(liveItem, liveBrief);
    const isBriefLeading = isBriefFirst(presentation, isShowBriefsOn, briefRowState);

    const actionButtons = renderActions ? (
        renderActions({ triggerSave: onSave, saveDisabled, isSaving, isDirty, hasTextEdits, isRoutineDestination: status === 'routine', onClose: closeEditor })
    ) : (
        <>
            <Button onClick={closeEditor}>Cancel</Button>
            <DisabledCapableTooltip title={`Save changes (${chordLabel(['mod', 'enter'], isApple)})`}>
                <Button variant="solid" disabled={saveDisabled} onClick={() => onSave()} aria-keyshortcuts={isApple ? 'Meta+Enter' : 'Control+Enter'}>
                    Save changes
                </Button>
            </DisabledCapableTooltip>
        </>
    );
    const actionsPlacement = resolveActionsPlacement(actionsContainer);
    // Portaled rows stretch across the host bar's content slot — see .inlineActions[data-stretched].
    const actionsRow = (
        <div className={styles.inlineActions} data-stretched={actionsPlacement.kind === 'portal' || undefined}>
            {actionButtons}
        </div>
    );

    const bodyProps = bodyPropsFor(presentation);
    return (
        // tabIndex -1: a click on the editor's empty space focuses the editor itself (not the page body), so its
        // letter and Alt+arrow shortcuts keep working; it is never a Tab stop.
        // biome-ignore lint/a11y/noStaticElementInteractions: a key-delegation scope, not a control — it hears the shortcuts its children's keys bubble up, and must stay a React handler so a child's stopPropagation (the brief field's Escape) is honoured
        <div
            {...bodyProps}
            className={clsx(bodyProps.className, styles.keyScope)}
            tabIndex={-1}
            {...{ [EDITOR_KEY_SCOPE_ATTR]: '' }}
            onKeyDown={onEditorKeyDown}
        >
            {conflictFields.length > 0 && (
                <Callout
                    tone="info"
                    onClose={() => setConflictFields([])}
                    action={
                        <Button tone="neutral" size="sm" onClick={adoptTheirVersion} data-testid="itemEditorUseTheirs">
                            Use their version
                        </Button>
                    }
                    data-testid="itemEditorConflictNotice"
                >
                    This item changed on another device ({conflictFields.join(', ')}). Your edits are kept and will overwrite on save.
                </Callout>
            )}
            <TextField
                label="Title"
                value={title}
                onChange={(e) => onTitleChange(e.target.value)}
                onBlur={() => void textAutosave.flush()}
                // Wraps instead of scrolling horizontally: a long title must be readable in full
                // without scrolling, in the editor and in the weekly review (which reuses this body).
                multiline
                // Enter would insert a newline in a multiline field — titles are single-line values,
                // so swallow it and commit what is typed so far. For meetings with attendees the
                // flush is a no-op: that text waits for an explicit Save (see textAutosaveEnabled).
                onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        void textAutosave.flush();
                    }
                }}
                fullWidth
                required
            />

            <BriefSection
                value={brief}
                state={briefRowState}
                origin={liveBrief?.origin}
                onChange={(next) => writeFormField('brief', next, setBrief)}
                onCommit={(value) => void flushBrief(value)}
                generation={briefGeneration}
                variant={isBriefLeading ? 'line' : 'field'}
                isBriefable={isBriefableItemStatus(liveItem.status)}
            />

            {status === 'calendar' && (
                <CalendarFields
                    value={calForm}
                    onChange={(patch) => writeFormField('cal', applyCalendarPatch(formRefs.current.cal, patch), setCalForm)}
                    calendarOptions={visibleCalendarOptions}
                    forceShowPicker={ownerUserId !== item.userId}
                />
            )}

            <NotesSection notes={notes} onNotesChange={onNotesChange} collapsible={isBriefLeading} />

            <Separator />

            <fieldset>
                <Text as="legend" variant="caption" tone="secondary" weight="semibold" className={styles.statusLabel}>
                    Status
                </Text>
                <div className={styles.statusChips}>
                    {STATUS_CHIPS.filter((cfg) => cfg.value !== 'routine' || canClarifyToRoutine(liveItem)).map((cfg) => (
                        // The tooltip teaches the chip's letter (it works with focus outside a text field).
                        <Tooltip key={cfg.value} title={chipTitle(cfg)}>
                            <Chip
                                icon={cfg.icon}
                                label={cfg.label}
                                size="md"
                                variant="outline"
                                // Only the selected chip takes its status tone; unselected, Done and Trash stay neutral like the rest.
                                tone={status === cfg.value ? cfg.tone : undefined}
                                // Announced as pressed and mirrored as data-selected (the DS Chip contract).
                                selected={status === cfg.value}
                                // The Tooltip would name the chip by its title ("Done (d)"); the name stays the label,
                                // the key is announced from aria-keyshortcuts.
                                aria-label={cfg.label}
                                data-testid="itemEditorStatusChip"
                                aria-keyshortcuts={statusKeyOf(cfg.value)?.toUpperCase()}
                                onClick={() => {
                                    setRoutineSaveError(null);
                                    writeFormField('status', cfg.value, setStatus);
                                }}
                            />
                        </Tooltip>
                    ))}
                </div>
            </fieldset>

            {/* Only while Done is both saved and selected — picking another chip shows that status's fields instead. */}
            {status === 'done' && doneContext && (
                <>
                    <Separator />
                    <DoneItemContextSection context={doneContext} />
                </>
            )}

            {liveItem.routineId && (
                <div data-testid="itemEditorRoutineLink">
                    <RoutineIndicator routineId={liveItem.routineId} routineTitle={allRoutines.find((r) => r._id === liveItem.routineId)?.title} forceChip />
                </div>
            )}

            {loggedInAccounts.length > 1 && (
                <div>
                    <AccountPicker
                        value={ownerUserId}
                        onChange={(uid) => {
                            writeFormField('ownerUserId', uid, setOwnerUserId);
                            setReassignError(null);
                            writeFormField(
                                'cal',
                                { ...formRefs.current.cal, calendarSyncConfigId: pickDefaultConfigForUser(calendarOptions, uid, item) },
                                setCalForm,
                            );
                        }}
                        disabled={isRoutineGenerated || isSaving}
                        {...(reassignError ? { error: reassignError } : {})}
                    />
                    {isRoutineGenerated && (
                        <Text as="span" variant="caption" tone="secondary" className={styles.accountHint}>
                            To move this, edit the routine itself.
                        </Text>
                    )}
                </div>
            )}

            {status === 'nextAction' && (
                <>
                    <Separator />
                    <NextActionFields
                        value={naForm}
                        onChange={(patch) => writeFormField('na', { ...formRefs.current.na, ...patch }, setNaForm)}
                        workContexts={pickerWorkContexts}
                        people={pickerPeople}
                        usage={entityUsage}
                        dense={presentation === 'review'}
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
                    <Separator />
                    <WaitingForFields
                        value={wfForm}
                        onChange={(patch) => writeFormField('wf', { ...formRefs.current.wf, ...patch }, setWfForm)}
                        people={pickerPeople}
                    />
                </>
            )}

            {status === 'somedayMaybe' && (
                <>
                    <Separator />
                    <div className={styles.statusFields}>
                        <Text variant="bodySm" tone="secondary">
                            Parked for later review. Optionally set a deadline or hide it from review until a date.
                        </Text>
                        <TicklerDateFields value={smForm} onChange={(patch) => writeFormField('sm', { ...formRefs.current.sm, ...patch }, setSmForm)} />
                    </div>
                </>
            )}

            {status === 'routine' && (
                <>
                    <Separator />
                    <div className={styles.statusFields} data-testid="itemEditorRoutineFields">
                        <Text variant="bodySm" tone="secondary">
                            Turns this item into a repeating routine. The item itself is consumed — the routine takes its title and notes.
                        </Text>
                        {routineSaveError && (
                            <Callout tone="error" data-testid="itemEditorRoutineSaveError">
                                {routineSaveError}
                            </Callout>
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
                    </div>
                </>
            )}

            {/* The item's place in its list's manual order — only while the chosen status is the SAVED one
                (an item being moved to another list lands at that list's top on save) and the list has a
                manual order (not the calendar). The weekly-review cards and the Process Inbox wizard (hosts
                with their own actions) leave it out — reordering is a list concern, not a step of their walk. */}
            {status === liveItem.status && rankSectionKeyOf(liveItem) !== null && presentation !== 'review' && !renderActions && (
                <NextActionPositionRow db={db} item={liveItem} onBeforeMove={() => flushItemTextLocallyRef.current()} />
            )}

            <Separator />

            <div className={styles.metaRow}>
                <Text as="span" variant="caption" tone="secondary" data-testid="itemEditorCreatedAt">
                    Created {dayjs(liveItem.createdTs).format('MMM D, YYYY h:mm A')}
                </Text>
                <Text as="span" variant="caption" tone="secondary" className={styles.itemId} data-testid="itemEditorId">
                    ID {item._id}
                </Text>
                {/* The shared hardened button (tooltip + failure snackbar). Hosts with their own
                    header CopyIdButton suppress this one so exactly one shows per screen. */}
                {!hasHostCopyIdButton && <CopyIdButton id={item._id} />}
            </div>

            {actionsPlacement.kind === 'inline' && actionsRow}
            {actionsPlacement.kind === 'portal' && createPortal(actionsRow, actionsPlacement.container)}
            <UnsavedChangesDialog blocker={navigationBlocker} />
            <FutureDoneConfirmDialog {...futureDone.dialogProps} />
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
        </div>
    );
}
