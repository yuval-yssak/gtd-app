import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import DialogActions from '@mui/material/DialogActions';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormLabel from '@mui/material/FormLabel';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { useState, useTransition } from 'react';
import type { ReassignRoutineEditPatch } from '../../api/syncApi';
import { useAppData } from '../../contexts/AppDataProvider';
import { usePendingReassign } from '../../contexts/PendingReassignProvider';
import {
    createFirstRoutineItem,
    deleteAndRegenerateFutureItems,
    generateCalendarItemsToHorizon,
    hardDeletePastItems,
    partitionPastItemsByDoneness,
    regenerateFutureItemContent,
} from '../../db/routineItemHelpers';
import { createRoutine, updateRoutine } from '../../db/routineMutations';
import { splitRoutine } from '../../db/routineSplit';
import { type CalendarOption, useCalendarOptions } from '../../hooks/useCalendarOptions';
import { computeSplitDate, routineHasPastItems, stripEndClauses } from '../../lib/routineSplitUtils';
import { hasAtLeastOne } from '../../lib/typeUtils';
import type { EnergyLevel, MyDB, StoredPerson, StoredRoutine, StoredWorkContext } from '../../types/MyDB';
import { AccountPicker } from '../AccountPicker';
import type { ItemEditorChrome } from '../editItemDialogLogic';
import { NotesSection } from '../itemEditor/NotesSection';
import { ReassignInFlightInline } from '../itemEditor/ReassignInFlightInline';
import { FrequencyPicker } from '../routines/FrequencyPicker';
import { isCalendarScheduleChanged, isStartDateChanged } from '../routines/routineEditDecision';
import styles from './RoutineEditorBody.module.css';

/**
 * Chrome variants the routine editor renders into. Aliased to `ItemEditorChrome` so the two
 * editors' chrome sets stay locked in sync — `NotesSection` consumes the item-editor type and
 * we'd silently break it if the routine editor added a chrome the notes section doesn't handle.
 */
export type RoutineEditorChrome = ItemEditorChrome;

type EndsMode = 'never' | 'onDate' | 'afterN';

interface FormState {
    routineType: 'nextAction' | 'calendar';
    title: string;
    rrule: string; // base rrule without UNTIL/COUNT — those are stored in endsMode/endsDate/endsCount
    workContextIds: string[];
    peopleIds: string[];
    energy: EnergyLevel | '';
    time: string;
    focus: boolean;
    urgent: boolean;
    notes: string;
    /** When true, generated calendar items are all-day; timeOfDay/duration are ignored on save. */
    allDay: boolean;
    timeOfDay: string; // HH:MM — calendar routines only (ignored when allDay)
    duration: string; // minutes — calendar routines only (ignored when allDay)
    calendarSyncConfigId: string; // empty = use default calendar
    endsMode: EndsMode;
    endsDate: string; // ISO date — used when endsMode === 'onDate'
    endsCount: string; // positive integer string — used when endsMode === 'afterN'
    startDate: string; // ISO date — anchors the rrule schedule. Empty = fall back to createdTs.
}

/**
 * Parse the compact RFC 5545 UTC datetime (YYYYMMDDTHHmmssZ) that UNTIL uses.
 * dayjs's default parser treats this as Invalid Date without an explicit format mask,
 * which corrupted the Ends mode on edit and silently triggered a split.
 */
function parseRruleUntil(raw: string): string {
    const match = raw.match(/^(\d{4})(\d{2})(\d{2})T\d{6}Z$/);
    if (!match) {
        return '';
    }
    return `${match[1]}-${match[2]}-${match[3]}`;
}

/** Parse UNTIL/COUNT from an existing rrule string into EndsMode fields. */
function parseEndsFromRrule(rruleStr: string): { endsMode: EndsMode; endsDate: string; endsCount: string } {
    const untilMatch = rruleStr.match(/UNTIL=([^;]+)/);
    const countMatch = rruleStr.match(/COUNT=(\d+)/);
    if (untilMatch) {
        const parsed = parseRruleUntil(untilMatch[1] ?? '');
        const endsDate = parsed || dayjs(untilMatch[1] ?? '').format('YYYY-MM-DD');
        return { endsMode: 'onDate', endsDate, endsCount: '' };
    }
    if (countMatch) {
        return { endsMode: 'afterN', endsDate: '', endsCount: countMatch[1] ?? '' };
    }
    return { endsMode: 'never', endsDate: '', endsCount: '' };
}

/** Build the final rrule by appending UNTIL or COUNT to the base rrule from FrequencyPicker. */
function buildFinalRrule(baseRrule: string, endsMode: EndsMode, endsDate: string, endsCount: string): string {
    if (endsMode === 'onDate' && endsDate) {
        // UNTIL must be in UTC datetime format per RFC 5545. Construct directly from the ISO date
        // to avoid depending on the dayjs utc plugin (not loaded in this project).
        const until = `${endsDate.replace(/-/g, '')}T235959Z`;
        return `${baseRrule};UNTIL=${until}`;
    }
    if (endsMode === 'afterN' && endsCount) {
        return `${baseRrule};COUNT=${endsCount}`;
    }
    return baseRrule;
}

function initFormState(routine?: StoredRoutine): FormState {
    const ends = parseEndsFromRrule(routine?.rrule ?? '');
    return {
        routineType: routine?.routineType ?? 'nextAction',
        title: routine?.title ?? '',
        rrule: stripEndClauses(routine?.rrule ?? 'FREQ=DAILY;INTERVAL=1'),
        workContextIds: routine?.template.workContextIds ?? [],
        peopleIds: routine?.template.peopleIds ?? [],
        energy: routine?.template.energy ?? '',
        time: routine?.template.time?.toString() ?? '',
        focus: routine?.template.focus ?? false,
        urgent: routine?.template.urgent ?? false,
        notes: routine?.template.notes ?? '',
        allDay: routine?.calendarItemTemplate?.allDay === true,
        timeOfDay: routine?.calendarItemTemplate?.timeOfDay ?? '09:00',
        duration: routine?.calendarItemTemplate?.duration?.toString() ?? '60',
        calendarSyncConfigId: routine?.calendarSyncConfigId ?? '',
        startDate: routine?.startDate ?? '',
        ...ends,
    };
}

/**
 * Pure helper that derives the `calendarItemTemplate` shape from the form's all-day toggle and
 * time/duration inputs. Extracted so it can be unit-tested without mounting the full editor.
 * Returns `undefined` for non-calendar routines so callers can spread it conditionally.
 */
export function buildRoutineTemplateFromForm(form: { routineType: 'nextAction' | 'calendar'; allDay: boolean; timeOfDay: string; duration: string }) {
    if (form.routineType !== 'calendar') {
        return undefined;
    }
    if (form.allDay) {
        return { allDay: true } as const;
    }
    return { timeOfDay: form.timeOfDay, duration: parseInt(form.duration, 10) || 60 };
}

/** Resolves calendarSyncConfigId + calendarIntegrationId from the form's selected config. */
function resolveCalendarLink(configId: string, options: CalendarOption[]): { calendarSyncConfigId?: string; calendarIntegrationId?: string } {
    if (configId) {
        const selected = options.find((o) => o.configId === configId);
        return selected ? { calendarSyncConfigId: selected.configId, calendarIntegrationId: selected.integrationId } : {};
    }
    const fallback = options.find((o) => o.isDefault) ?? (hasAtLeastOne(options) ? options[0] : undefined);
    return fallback ? { calendarIntegrationId: fallback.integrationId } : {};
}

/**
 * Builds the editRoutinePatch for a cross-account routine reassign. Diffs each whitelisted field
 * against the routine's current value and emits only those that changed (template is always
 * emitted because it's a small object that's cheap to ship and the user may have toggled chips).
 *
 * Exported for unit-testing — verifies the diffing matches the same-account local-update logic.
 */
export function buildRoutineEditPatch(args: {
    routine: StoredRoutine;
    title: string;
    rrule: string;
    routineType: 'nextAction' | 'calendar';
    template: { workContextIds?: string[]; peopleIds?: string[]; energy?: EnergyLevel; time?: number; focus?: boolean; urgent?: boolean; notes?: string };
    /** All-day routines carry `{ allDay: true }`; timed routines carry `{ timeOfDay, duration }`. */
    calendarItemTemplate?: { allDay: true } | { timeOfDay: string; duration: number };
    startDate?: string;
    /**
     * True when the editor was opened on a paused routine and Save should also resume it.
     * Mirrors the same-account path's `resumeOnSave = !routine.active` semantics so a cross-account
     * save honours the "Save your changes to resume it" banner shown above paused routines.
     */
    resumeOnSave?: boolean;
}): ReassignRoutineEditPatch {
    const patch: ReassignRoutineEditPatch = {};
    if (args.title !== args.routine.title) {
        patch.title = args.title;
    }
    if (args.rrule !== args.routine.rrule) {
        patch.rrule = args.rrule;
    }
    if (args.routineType !== args.routine.routineType) {
        patch.routineType = args.routineType;
    }
    patch.template = args.template;
    if (args.calendarItemTemplate !== undefined) {
        patch.calendarItemTemplate = args.calendarItemTemplate;
    }
    const originalStartDate = args.routine.startDate ?? '';
    const nextStartDate = args.startDate ?? '';
    if (nextStartDate !== originalStartDate) {
        patch.startDate = nextStartDate;
    }
    if (args.resumeOnSave) {
        patch.active = true;
    }
    return patch;
}

/**
 * Narrowing helpers for the discriminated calendarItemTemplate union. The all-day variant has only
 * `allDay`; the timed variant has `timeOfDay`/`duration`. Returning `undefined` from the wrong-side
 * accessor keeps the edit-intent shape compatible with `RoutineEditIntent`.
 */
function getTemplateAllDay(template: { allDay: true } | { timeOfDay: string; duration: number } | undefined): boolean {
    return template !== undefined && 'allDay' in template && template.allDay === true;
}
function getTemplateTimeOfDay(template: { allDay: true } | { timeOfDay: string; duration: number } | undefined): string | undefined {
    if (template === undefined || 'allDay' in template) {
        return undefined;
    }
    return template.timeOfDay;
}
function getTemplateDuration(template: { allDay: true } | { timeOfDay: string; duration: number } | undefined): number | undefined {
    if (template === undefined || 'allDay' in template) {
        return undefined;
    }
    return template.duration;
}

function buildTemplate(form: FormState) {
    return {
        ...(form.workContextIds.length ? { workContextIds: form.workContextIds } : {}),
        ...(form.peopleIds.length ? { peopleIds: form.peopleIds } : {}),
        ...(form.energy ? { energy: form.energy as EnergyLevel } : {}),
        ...(form.time ? { time: parseInt(form.time, 10) } : {}),
        ...(form.focus ? { focus: true } : {}),
        ...(form.urgent ? { urgent: true } : {}),
        ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
    };
}

/** Shape of the calendarSyncConfigId / calendarIntegrationId pair attached to a routine. */
interface CalendarLink {
    calendarSyncConfigId?: string;
    calendarIntegrationId?: string;
}

/**
 * Pre-computed values shared by every save branch (reassign / edit-with-startDate-change /
 * edit-without-startDate-change / create). Built once at the top of `onSave` so each branch
 * helper operates at a single level of abstraction.
 */
export interface SaveContext {
    trimmedTitle: string;
    finalRrule: string;
    routineType: 'nextAction' | 'calendar';
    template: ReturnType<typeof buildTemplate>;
    calendarItemTemplate: ReturnType<typeof buildRoutineTemplateFromForm>;
    calendarLink: CalendarLink;
    /** Undefined when the form's startDate is empty (treated as "unset" everywhere). */
    formStartDate: string | undefined;
}

/**
 * Decisions derived from comparing the edit form to the stored routine. Bundles
 * `scheduleChanged` and `resumeOnSave` so the no-startDate-change branch can pass a single
 * domain value instead of two booleans (CLAUDE.md ≤3 args rule).
 */
export interface EditDecision {
    scheduleChanged: boolean;
    resumeOnSave: boolean;
}

/**
 * Builds the in-place `StoredRoutine` update payload that both edit branches write to IDB.
 * Centralises the conditional spread plumbing for calendarItemTemplate / calendarLink / startDate
 * plus the "delete startDate when unset" tweak — previously inlined in two places.
 *
 * Exported for unit-testing.
 */
export function buildUpdatedRoutine(routine: StoredRoutine, ctx: SaveContext, active: boolean | undefined): StoredRoutine {
    const updated: StoredRoutine = {
        ...routine,
        routineType: ctx.routineType,
        title: ctx.trimmedTitle,
        rrule: ctx.finalRrule,
        template: ctx.template,
        ...(active !== undefined ? { active } : {}),
        ...(ctx.calendarItemTemplate !== undefined ? { calendarItemTemplate: ctx.calendarItemTemplate } : {}),
        ...ctx.calendarLink,
        ...(ctx.formStartDate ? { startDate: ctx.formStartDate } : {}),
    };
    if (!ctx.formStartDate) {
        delete updated.startDate;
    }
    return updated;
}

/**
 * Builds the `editedFields` payload passed to `splitRoutine` for both the donePast-split and the
 * scheduleChanged-split call sites. The shape is `Omit<StoredRoutine, '_id'|'userId'|'createdTs'|'updatedTs'|'active'>`
 * — `splitRoutine` synthesises those itself for the tail routine.
 *
 * Exported for unit-testing.
 */
export function buildSplitPatch(ctx: SaveContext): Omit<StoredRoutine, '_id' | 'userId' | 'createdTs' | 'updatedTs' | 'active'> {
    return {
        routineType: ctx.routineType,
        title: ctx.trimmedTitle,
        rrule: ctx.finalRrule,
        template: ctx.template,
        ...(ctx.calendarItemTemplate !== undefined ? { calendarItemTemplate: ctx.calendarItemTemplate } : {}),
        ...ctx.calendarLink,
        ...(ctx.formStartDate ? { startDate: ctx.formStartDate } : {}),
    };
}

/** True when `startDate` is set AND strictly after today. The boot-tick will materialise the routine on the day. */
function isFutureStartDate(startDate: string | undefined): boolean {
    if (startDate === undefined) {
        return false;
    }
    const todayStr = dayjs().startOf('day').format('YYYY-MM-DD');
    return startDate > todayStr;
}

/**
 * Edit branch: routine.startDate changed. If any past items are done we split (preserve their
 * schedule); otherwise hard-delete the open past items and update in place, then either
 * regenerate future calendar items or seed the first nextAction item (skipping when the new
 * startDate is in the future — the boot-tick will materialise it).
 *
 * Exported for unit-testing.
 */
export async function saveEditWithStartDateChange(db: IDBPDatabase<MyDB>, routine: StoredRoutine, ctx: SaveContext): Promise<void> {
    const { donePast, nonDonePast } = await partitionPastItemsByDoneness(db, routine.userId, routine._id);
    if (donePast.length > 0) {
        const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
        await splitRoutine(db, routine.userId, routine, buildSplitPatch(ctx), yesterday);
        return;
    }
    await hardDeletePastItems(db, nonDonePast);
    const updatedRoutine = buildUpdatedRoutine(routine, ctx, true);
    await updateRoutine(db, updatedRoutine);
    await seedAfterStartDateChange(db, updatedRoutine, ctx);
}

/** Regenerates calendar items or seeds the first nextAction item after a startDate-change update. */
async function seedAfterStartDateChange(db: IDBPDatabase<MyDB>, updatedRoutine: StoredRoutine, ctx: SaveContext): Promise<void> {
    if (ctx.routineType === 'calendar') {
        await deleteAndRegenerateFutureItems(db, updatedRoutine.userId, updatedRoutine);
        return;
    }
    if (isFutureStartDate(ctx.formStartDate)) {
        return;
    }
    await createFirstRoutineItem(db, updatedRoutine.userId, updatedRoutine);
}

/**
 * Edit branch: routine.startDate unchanged. When the schedule changed AND past items already
 * exist for this routine, split at the computed split date. Otherwise update in place and
 * regenerate calendar items only when needed (schedule changed or resuming from pause).
 *
 * Exported for unit-testing.
 */
export async function saveEditWithoutStartDateChange(db: IDBPDatabase<MyDB>, routine: StoredRoutine, ctx: SaveContext): Promise<void> {
    const decision = deriveEditDecision(routine, ctx);
    const hasPastItems = decision.scheduleChanged ? await routineHasPastItems(db, routine.userId, routine._id) : false;
    const splitDate = hasPastItems ? computeSplitDate(routine.rrule, routine.createdTs) : null;
    if (splitDate) {
        await splitRoutine(db, routine.userId, routine, buildSplitPatch(ctx), splitDate);
        return;
    }
    const updatedRoutine = buildUpdatedRoutine(routine, ctx, decision.resumeOnSave ? true : undefined);
    await updateRoutine(db, updatedRoutine);
    if (routine.routineType !== 'calendar' || ctx.routineType !== 'calendar') {
        return;
    }
    await regenerateCalendarItemsForSameTypeEdit(db, updatedRoutine, decision);
}

/** Computes the `EditDecision` for an edit (schedule-changed + paused→resume). Pure. */
function deriveEditDecision(routine: StoredRoutine, ctx: SaveContext): EditDecision {
    return {
        scheduleChanged: isCalendarScheduleChanged(routine, buildEditIntentFromContext(ctx)),
        resumeOnSave: !routine.active,
    };
}

/** Pure helper: shapes a `SaveContext` into the `RoutineEditIntent` consumed by the decision predicates. */
function buildEditIntentFromContext(ctx: SaveContext) {
    return {
        routineType: ctx.routineType,
        rrule: ctx.finalRrule,
        timeOfDay: getTemplateTimeOfDay(ctx.calendarItemTemplate),
        duration: getTemplateDuration(ctx.calendarItemTemplate),
        allDay: getTemplateAllDay(ctx.calendarItemTemplate),
        startDate: ctx.formStartDate,
    };
}

/**
 * Already inside a confirmed calendar→calendar edit. Picks between full regen and notes-only
 * regen based on the decision. Caller has already checked both type sides are calendar.
 */
async function regenerateCalendarItemsForSameTypeEdit(db: IDBPDatabase<MyDB>, updatedRoutine: StoredRoutine, decision: EditDecision): Promise<void> {
    if (decision.scheduleChanged || decision.resumeOnSave) {
        await deleteAndRegenerateFutureItems(db, updatedRoutine.userId, updatedRoutine);
        return;
    }
    await regenerateFutureItemContent(db, updatedRoutine.userId, updatedRoutine);
}

/**
 * Create branch: persist the new routine and seed its first item(s). Errors are logged, not thrown.
 *
 * Exported for unit-testing.
 */
export async function saveCreate(db: IDBPDatabase<MyDB>, userId: string, ctx: SaveContext): Promise<void> {
    const created = await createRoutine(db, {
        userId,
        routineType: ctx.routineType,
        rrule: ctx.finalRrule,
        template: ctx.template,
        title: ctx.trimmedTitle,
        active: true,
        ...(ctx.calendarItemTemplate !== undefined ? { calendarItemTemplate: ctx.calendarItemTemplate } : {}),
        ...ctx.calendarLink,
        ...(ctx.formStartDate ? { startDate: ctx.formStartDate } : {}),
    });
    try {
        await seedNewRoutineFirstItems(db, created, ctx);
    } catch (err) {
        console.error('[routine] failed to create items:', err);
    }
}

/** Seeds the first item for a newly-created routine — calendar fills the horizon; nextAction seeds one (unless future). */
async function seedNewRoutineFirstItems(db: IDBPDatabase<MyDB>, created: StoredRoutine, ctx: SaveContext): Promise<void> {
    if (ctx.routineType === 'calendar') {
        await generateCalendarItemsToHorizon(db, created.userId, created);
        return;
    }
    if (isFutureStartDate(ctx.formStartDate)) {
        return;
    }
    await createFirstRoutineItem(db, created.userId, created);
}

/** Resolves the body-class for the chrome variant. */
function bodyClassFor(chrome: RoutineEditorChrome): string {
    if (chrome === 'expand') return styles.bodyExpand;
    if (chrome === 'popover') return styles.bodyPopover;
    return styles.body;
}

export interface RoutineEditorBodyProps {
    db: IDBPDatabase<MyDB>;
    /** Default-owner userId for new routines. Ignored for edits — the routine carries its own owner. */
    userId: string;
    workContexts: StoredWorkContext[];
    people: StoredPerson[];
    /** Pass an existing routine to edit it; omit to create a new one. */
    routine?: StoredRoutine | undefined;
    onClose: () => void;
    onSaved: () => Promise<void>;
    /** Determines which actions container is rendered and visual padding. Dialog wrapper sets 'dialog'. */
    chrome: RoutineEditorChrome;
}

/**
 * Unified routine editor body — owns all state, save logic, and the per-type forms. Chrome
 * wrappers (Dialog/Popover/Expand/page) supply only the surrounding container; the body's
 * appearance is tuned via `chrome` to match each variant.
 *
 * Wrappers MUST set `key={routine?._id ?? 'new'}` so React remounts the body when the editor
 * opens on a different routine — otherwise local form state would seed from the wrong routine.
 */
export function RoutineEditorBody({ db, userId, workContexts, people, routine, onClose, onSaved, chrome }: RoutineEditorBodyProps) {
    const isEdit = routine !== undefined;
    const [form, setForm] = useState<FormState>(() => initFormState(routine));
    const [isSaving, startSaving] = useTransition();
    const { options: calendarOptions } = useCalendarOptions();
    const { loggedInAccounts } = useAppData();
    const { runReassignWithOverlay, isPending } = usePendingReassign();
    // Refuse to render the form while a cross-account reassign is in flight on this routine —
    // the form would seed `ownerUserId` from the overlayed (target) user and a save would write
    // IDB under the target. The Dialog wrapper has its own short-circuit (`RoutineDialog.tsx`),
    // but popover/expand/page mount the body directly and need the same guard. Read here, render
    // the guard after all hooks below (rules-of-hooks).
    const reassignInFlight = routine !== undefined && isPending('routine', routine._id);
    const [ownerUserId, setOwnerUserId] = useState<string>(routine?.userId ?? userId);

    function patch(update: Partial<FormState>) {
        setForm((f) => ({ ...f, ...update }));
    }

    function toggleWorkContext(id: string) {
        const ids = form.workContextIds.includes(id) ? form.workContextIds.filter((x) => x !== id) : [...form.workContextIds, id];
        patch({ workContextIds: ids });
    }

    function togglePerson(id: string) {
        const ids = form.peopleIds.includes(id) ? form.peopleIds.filter((x) => x !== id) : [...form.peopleIds, id];
        patch({ peopleIds: ids });
    }

    function onSave() {
        const trimmedTitle = form.title.trim();
        if (!trimmedTitle || !form.rrule || isSaving) {
            return;
        }
        // All-day routines don't require a time-of-day input — the timeOfDay value is hidden
        // and ignored. Only enforce the time-of-day requirement on timed calendar routines.
        if (form.routineType === 'calendar' && !form.allDay && !form.timeOfDay) {
            return;
        }

        startSaving(async () => {
            const ctx = buildSaveContext();
            // Reassign is fire-and-forget: it owns its own onSaved() via runReassignWithOverlay's
            // .then(). Bailing here keeps the outer postlude from double-firing onSaved/onClose
            // before the reassign has actually committed.
            if (routine && ownerUserId !== routine.userId) {
                dispatchReassign(routine, ctx);
                return;
            }
            if (routine) {
                await dispatchEditSameOwner(routine, ctx);
            } else {
                await saveCreate(db, userId, ctx);
            }
            await onSaved();
            onClose();
        });

        function buildSaveContext(): SaveContext {
            const finalRrule = buildFinalRrule(form.rrule, form.endsMode, form.endsDate, form.endsCount);
            const calendarLink: CalendarLink = form.routineType === 'calendar' ? resolveCalendarLink(form.calendarSyncConfigId, calendarOptions) : {};
            return {
                trimmedTitle,
                finalRrule,
                routineType: form.routineType,
                template: buildTemplate(form),
                calendarItemTemplate: buildRoutineTemplateFromForm(form),
                calendarLink,
                formStartDate: form.startDate || undefined,
            };
        }

        async function dispatchEditSameOwner(currentRoutine: StoredRoutine, ctx: SaveContext): Promise<void> {
            if (isStartDateChanged(currentRoutine, buildEditIntentFromContext(ctx))) {
                await saveEditWithStartDateChange(db, currentRoutine, ctx);
                return;
            }
            await saveEditWithoutStartDateChange(db, currentRoutine, ctx);
        }

        function dispatchReassign(currentRoutine: StoredRoutine, ctx: SaveContext): void {
            startRoutineReassignInBackground({
                routine: currentRoutine,
                toUserId: ownerUserId,
                title: ctx.trimmedTitle,
                rrule: ctx.finalRrule,
                routineType: ctx.routineType,
                template: ctx.template,
                ...(ctx.calendarItemTemplate !== undefined ? { calendarItemTemplate: ctx.calendarItemTemplate } : {}),
                ...(ctx.formStartDate ? { startDate: ctx.formStartDate } : {}),
                ...(ctx.calendarLink.calendarIntegrationId !== undefined ? { targetIntegrationId: ctx.calendarLink.calendarIntegrationId } : {}),
                ...(ctx.calendarLink.calendarSyncConfigId !== undefined ? { targetSyncConfigId: ctx.calendarLink.calendarSyncConfigId } : {}),
                resumeOnSave: !currentRoutine.active,
            });
            onClose();
        }
    }

    /**
     * Registers the presentational overlay and fires /sync/reassign in the background. The
     * editor closes before this resolves — `runReassignWithOverlay` owns the failure UX
     * (snackbar revert).
     */
    function startRoutineReassignInBackground(args: {
        routine: StoredRoutine;
        toUserId: string;
        title: string;
        rrule: string;
        routineType: 'nextAction' | 'calendar';
        template: ReturnType<typeof buildTemplate>;
        // All-day routines carry only `{ allDay: true }`; timed routines carry `{ timeOfDay, duration }`.
        calendarItemTemplate?: { allDay: true } | { timeOfDay: string; duration: number };
        startDate?: string;
        resumeOnSave?: boolean;
        targetIntegrationId?: string;
        targetSyncConfigId?: string;
    }): void {
        const editRoutinePatch = buildRoutineEditPatch(args);
        runReassignWithOverlay({
            kind: 'routine',
            entityId: args.routine._id,
            label: args.title,
            override: {
                toUserId: args.toUserId,
                ...(args.targetIntegrationId !== undefined ? { targetIntegrationId: args.targetIntegrationId } : {}),
                ...(args.targetSyncConfigId !== undefined ? { targetSyncConfigId: args.targetSyncConfigId } : {}),
            },
            params: {
                entityType: 'routine',
                entityId: args.routine._id,
                fromUserId: args.routine.userId,
                toUserId: args.toUserId,
                editRoutinePatch,
            },
        })
            .then(() => onSaved())
            .catch((err) => console.error('[routine reassign] post-flight refresh failed:', err));
    }

    const isCalendar = form.routineType === 'calendar';
    const isEndedCalendar = isEdit && routine.routineType === 'calendar' && computeSplitDate(routine.rrule, routine.createdTs) === null;
    const saveDisabled = !form.title.trim() || !form.rrule || isSaving;

    if (reassignInFlight) {
        // Dialog wrapper short-circuits to RoutineReassignInFlightDialog before mounting the body,
        // so this branch only fires under popover/expand/page.
        return (
            <Box className={bodyClassFor(chrome)}>
                <ReassignInFlightInline onClose={onClose} entityLabel="routine" />
            </Box>
        );
    }

    return (
        <Box className={bodyClassFor(chrome)}>
            {isEdit && !routine.active && (
                <Alert severity="info" variant="outlined">
                    This routine is paused. Save your changes to resume it.
                </Alert>
            )}
            {isEndedCalendar && (
                <Alert severity="info" variant="outlined">
                    This routine has ended. Only title and notes can be edited.
                </Alert>
            )}

            <TextField label="Title" value={form.title} onChange={(e) => patch({ title: e.target.value })} fullWidth required autoFocus={chrome === 'dialog'} />

            <Box>
                <FormLabel>
                    <Typography
                        variant="caption"
                        className={styles.sectionLabel}
                        sx={{
                            color: 'text.secondary',
                        }}
                    >
                        Type
                    </Typography>
                </FormLabel>
                <ToggleButtonGroup
                    exclusive
                    size="small"
                    value={form.routineType}
                    disabled={isEndedCalendar}
                    onChange={(_e, val: 'nextAction' | 'calendar' | null) => {
                        if (val) patch({ routineType: val });
                    }}
                >
                    <ToggleButton value="nextAction">Next Action</ToggleButton>
                    <ToggleButton value="calendar">Calendar</ToggleButton>
                </ToggleButtonGroup>
            </Box>

            <Box>
                <FormLabel>
                    <Typography
                        variant="caption"
                        className={styles.sectionLabel}
                        sx={{
                            color: 'text.secondary',
                        }}
                    >
                        Frequency
                    </Typography>
                </FormLabel>
                {/* key resets FrequencyPicker internal state when switching between create/edit */}
                <FrequencyPicker key={routine?._id ?? 'new'} value={form.rrule} onChange={(rrule) => patch({ rrule })} disabled={isEndedCalendar} />
            </Box>

            <TextField
                type="date"
                label="Start date"
                size="small"
                value={form.startDate}
                onChange={(e) => patch({ startDate: e.target.value })}
                slotProps={{ inputLabel: { shrink: true } }}
                helperText="Optional — anchors the schedule. Leave empty to start today."
                disabled={isEndedCalendar}
            />

            <EndsFields form={form} onPatch={patch} disabled={isEndedCalendar} />

            {isCalendar ? (
                <CalendarFields form={form} onPatch={patch} calendarOptions={calendarOptions} disabled={isEndedCalendar} />
            ) : (
                <TemplateFields
                    form={form}
                    workContexts={workContexts}
                    people={people}
                    onPatch={patch}
                    onToggleWorkContext={toggleWorkContext}
                    onTogglePerson={togglePerson}
                />
            )}

            <NotesSection notes={form.notes} onNotesChange={(notes) => patch({ notes })} chrome={chrome} />

            {/* Account picker — auto-hides on single-account devices */}
            {loggedInAccounts.length > 1 && <AccountPicker value={ownerUserId} onChange={setOwnerUserId} disabled={isSaving} />}

            {chrome === 'dialog' ? (
                <DialogActions sx={{ px: 0 }}>
                    <Button onClick={onClose}>Cancel</Button>
                    <Button variant="contained" disabled={saveDisabled} onClick={() => onSave()} data-testid="routineEditorSaveButton">
                        {isEdit ? 'Save changes' : 'Create routine'}
                    </Button>
                </DialogActions>
            ) : (
                <Box className={styles.inlineActions}>
                    <Button onClick={onClose}>Cancel</Button>
                    <Button variant="contained" disabled={saveDisabled} onClick={() => onSave()} data-testid="routineEditorSaveButton">
                        {isEdit ? 'Save changes' : 'Create routine'}
                    </Button>
                </Box>
            )}
        </Box>
    );
}

// ── Calendar-specific fields ───────────────────────────────────────────────────

function CalendarFields({
    form,
    onPatch,
    calendarOptions,
    disabled,
}: {
    form: FormState;
    onPatch: (patch: Partial<FormState>) => void;
    calendarOptions: CalendarOption[];
    disabled?: boolean;
}) {
    const showPicker = calendarOptions.length > 1;

    return (
        <Stack
            sx={[
                {
                    gap: 1.5,
                },
                disabled ? { opacity: 0.5, pointerEvents: 'none' } : false,
            ]}
        >
            <Typography
                variant="caption"
                sx={{
                    color: 'text.secondary',
                    fontWeight: 600,
                }}
            >
                Calendar event settings
            </Typography>
            {/* All-day toggle hides the time + duration inputs below (they're meaningless for
                all-day events). Saving with allDay=true emits `{ allDay: true }` as the template. */}
            <FormControlLabel
                control={
                    <Switch checked={form.allDay} onChange={(e) => onPatch({ allDay: e.target.checked })} slotProps={{ input: { 'aria-label': 'All day' } }} />
                }
                label={<Typography variant="body2">All day</Typography>}
                data-testid="routineAllDayToggle"
            />
            {!form.allDay && (
                <Stack
                    direction="row"
                    sx={{
                        gap: 2,
                        alignItems: 'center',
                    }}
                >
                    <TextField
                        label="Start time"
                        type="time"
                        value={form.timeOfDay}
                        onChange={(e) => onPatch({ timeOfDay: e.target.value })}
                        size="small"
                        required
                        slotProps={{ inputLabel: { shrink: true } }}
                    />
                    <TextField
                        label="Duration (min)"
                        type="number"
                        value={form.duration}
                        onChange={(e) => onPatch({ duration: e.target.value })}
                        size="small"
                        className={styles.narrowInput}
                        slotProps={{ htmlInput: { min: 1 } }}
                    />
                </Stack>
            )}
            {/* Only show picker when user has 2+ calendars — with 0-1 there's nothing to choose. */}
            {showPicker && (
                <CalendarPicker calendarOptions={calendarOptions} value={form.calendarSyncConfigId} onChange={(v) => onPatch({ calendarSyncConfigId: v })} />
            )}
        </Stack>
    );
}

/** Groups calendar options by owning account so the picker shows one section per account. */
function groupCalendarsByAccount(calendarOptions: CalendarOption[]): Map<string, CalendarOption[]> {
    const groups = new Map<string, CalendarOption[]>();
    for (const opt of calendarOptions) {
        const list = groups.get(opt.accountEmail);
        if (list) {
            list.push(opt);
            continue;
        }
        groups.set(opt.accountEmail, [opt]);
    }
    return groups;
}

function CalendarPicker({ calendarOptions, value, onChange }: { calendarOptions: CalendarOption[]; value: string; onChange: (v: string) => void }) {
    const grouped = groupCalendarsByAccount(calendarOptions);
    const showAccountHeaders = grouped.size > 1;
    return (
        <TextField select label="Calendar" value={value} onChange={(e) => onChange(e.target.value)} size="small">
            <MenuItem value="">Default</MenuItem>
            {Array.from(grouped.entries()).flatMap(([email, opts]) => [
                ...(showAccountHeaders
                    ? [
                          <MenuItem key={`hdr-${email}`} aria-disabled value="" tabIndex={-1} className={styles.accountHeader}>
                              {email}
                          </MenuItem>,
                      ]
                    : []),
                ...opts.map((opt) => (
                    <MenuItem key={opt.configId} value={opt.configId}>
                        {opt.displayName}
                    </MenuItem>
                )),
            ])}
        </TextField>
    );
}

// ── Ends section ──────────────────────────────────────────────────────────────

function EndsFields({ form, onPatch, disabled }: { form: FormState; onPatch: (patch: Partial<FormState>) => void; disabled?: boolean }) {
    return (
        <Box sx={disabled ? { opacity: 0.5, pointerEvents: 'none' } : undefined}>
            <FormLabel>
                <Typography
                    variant="caption"
                    className={styles.sectionLabel}
                    sx={{
                        color: 'text.secondary',
                    }}
                >
                    Ends
                </Typography>
            </FormLabel>
            <ToggleButtonGroup
                exclusive
                size="small"
                value={form.endsMode}
                onChange={(_e, val: EndsMode | null) => {
                    if (val) onPatch({ endsMode: val });
                }}
            >
                <ToggleButton value="never">Never</ToggleButton>
                <ToggleButton value="onDate">On date</ToggleButton>
                <ToggleButton value="afterN">After N</ToggleButton>
            </ToggleButtonGroup>
            {form.endsMode === 'onDate' && (
                <TextField
                    type="date"
                    size="small"
                    value={form.endsDate}
                    onChange={(e) => onPatch({ endsDate: e.target.value })}
                    sx={{ mt: 1, display: 'block' }}
                    slotProps={{ inputLabel: { shrink: true } }}
                    label="End date"
                />
            )}
            {form.endsMode === 'afterN' && (
                <div className={styles.ticklerRow}>
                    <Typography variant="body2">After</Typography>
                    <TextField
                        type="number"
                        size="small"
                        className={styles.narrowInput}
                        value={form.endsCount}
                        onChange={(e) => onPatch({ endsCount: e.target.value })}
                        slotProps={{ htmlInput: { min: 1 } }}
                    />
                    <Typography variant="body2">occurrences</Typography>
                </div>
            )}
        </Box>
    );
}

// ── Next-action template fields ────────────────────────────────────────────────

interface TemplateFieldsProps {
    form: FormState;
    workContexts: StoredWorkContext[];
    people: StoredPerson[];
    onPatch: (patch: Partial<FormState>) => void;
    onToggleWorkContext: (id: string) => void;
    onTogglePerson: (id: string) => void;
}

function TemplateFields({ form, workContexts, people, onPatch, onToggleWorkContext, onTogglePerson }: TemplateFieldsProps) {
    return (
        <Stack
            sx={{
                gap: 1.5,
            }}
        >
            <Typography
                variant="caption"
                sx={{
                    color: 'text.secondary',
                    fontWeight: 600,
                }}
            >
                Template fields (copied onto each generated item)
            </Typography>
            {workContexts.length > 0 && (
                <Box>
                    <FormLabel>
                        <Typography
                            variant="caption"
                            sx={{
                                color: 'text.secondary',
                            }}
                        >
                            Work contexts
                        </Typography>
                    </FormLabel>
                    <Stack
                        direction="row"
                        sx={{
                            flexWrap: 'wrap',
                            gap: 0.75,
                            mt: 0.5,
                        }}
                    >
                        {workContexts.map((ctx) => (
                            <Chip
                                key={ctx._id}
                                label={ctx.name}
                                size="small"
                                variant={form.workContextIds.includes(ctx._id) ? 'filled' : 'outlined'}
                                color={form.workContextIds.includes(ctx._id) ? 'primary' : 'default'}
                                onClick={() => onToggleWorkContext(ctx._id)}
                            />
                        ))}
                    </Stack>
                </Box>
            )}
            {people.length > 0 && (
                <Box>
                    <FormLabel>
                        <Typography
                            variant="caption"
                            sx={{
                                color: 'text.secondary',
                            }}
                        >
                            People
                        </Typography>
                    </FormLabel>
                    <Stack
                        direction="row"
                        sx={{
                            flexWrap: 'wrap',
                            gap: 0.75,
                            mt: 0.5,
                        }}
                    >
                        {people.map((p) => (
                            <Chip
                                key={p._id}
                                label={p.name}
                                size="small"
                                variant={form.peopleIds.includes(p._id) ? 'filled' : 'outlined'}
                                color={form.peopleIds.includes(p._id) ? 'primary' : 'default'}
                                onClick={() => onTogglePerson(p._id)}
                            />
                        ))}
                    </Stack>
                </Box>
            )}
            <Box>
                <FormLabel>
                    <Typography
                        variant="caption"
                        sx={{
                            color: 'text.secondary',
                        }}
                    >
                        Energy
                    </Typography>
                </FormLabel>
                <ToggleButtonGroup
                    exclusive
                    size="small"
                    value={form.energy || null}
                    onChange={(_e, val: EnergyLevel | null) => onPatch({ energy: val ?? '' })}
                    sx={{ mt: 0.5 }}
                >
                    <ToggleButton value="low">Low</ToggleButton>
                    <ToggleButton value="medium">Medium</ToggleButton>
                    <ToggleButton value="high">High</ToggleButton>
                </ToggleButtonGroup>
            </Box>
            <TextField
                label="Time estimate (min)"
                value={form.time}
                onChange={(e) => onPatch({ time: e.target.value })}
                type="number"
                size="small"
                className={styles.narrowInput}
                slotProps={{ htmlInput: { min: 1 } }}
            />
            <Stack
                direction="row"
                sx={{
                    gap: 2,
                }}
            >
                <FormControlLabel
                    control={<Checkbox size="small" checked={form.urgent} onChange={(e) => onPatch({ urgent: e.target.checked })} />}
                    label={<Typography variant="body2">Urgent</Typography>}
                />
                <FormControlLabel
                    control={<Checkbox size="small" checked={form.focus} onChange={(e) => onPatch({ focus: e.target.checked })} />}
                    label={<Typography variant="body2">In focus</Typography>}
                />
            </Stack>
        </Stack>
    );
}
