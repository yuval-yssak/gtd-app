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
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import type { ReassignRoutineEditPatch } from '../../api/syncApi';
import { useAppData } from '../../contexts/AppDataProvider';
import { usePendingReassign } from '../../contexts/PendingReassignProvider';
import {
    createFirstRoutineItem,
    deleteAndRegenerateFutureItems,
    generateCalendarItemsToHorizon,
    hardDeletePastItems,
    hasOpenRoutineItem,
    type OpenItemSyncResult,
    partitionPastItemsByDoneness,
    persistRoutineTextEdit,
    regenerateFutureItemContent,
    restoreTrashedRoutineItem,
    syncOpenItemAfterNextActionEdit,
    trashNativeItemsForTypeSwitch,
} from '../../db/routineItemHelpers';
import { createRoutine, updateRoutine } from '../../db/routineMutations';
import { splitRoutine } from '../../db/routineSplit';
import { useAutosave } from '../../hooks/useAutosave';
import { type CalendarOption, useCalendarOptions } from '../../hooks/useCalendarOptions';
import { useEntityUsage } from '../../hooks/useEntityUsage';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import { omitArchived, rankByUsage, type UsageIndex } from '../../lib/entityUsage';
import { scopeOptionsToOwner } from '../../lib/ownerScopedPickerOptions';
import { computeSplitDate, routineHasPastItems, stripEndClauses } from '../../lib/routineSplitUtils';
import { deriveRecurrenceAnchor, RruleExhaustedError } from '../../lib/rruleUtils';
import { sortByName } from '../../lib/sortByName';
import { hasAtLeastOne } from '../../lib/typeUtils';
import { offerUndo } from '../../lib/undoStore';
import type { EnergyLevel, MyDB, StoredItem, StoredPerson, StoredRoutine, StoredWorkContext } from '../../types/MyDB';
import { AccountPicker } from '../AccountPicker';
import type { ItemEditorChrome } from '../editItemDialogLogic';
import { mergeFormGroup } from '../itemEditor/itemEditorLiveMerge';
import { NotesSection } from '../itemEditor/NotesSection';
import { ReassignInFlightInline } from '../itemEditor/ReassignInFlightInline';
import { CollapsibleChipGroup } from '../pickers/CollapsibleChipGroup';
import { FrequencyPicker } from '../routines/FrequencyPicker';
import { isCalendarScheduleChanged, isNextActionScheduleChanged, isStartDateChanged } from '../routines/routineEditDecision';
import { UnsavedChangesDialog } from '../UnsavedChangesDialog';
import styles from './RoutineEditorBody.module.css';

/**
 * Chrome variants the routine editor renders into. Aliased to `ItemEditorChrome` so the two
 * editors' chrome sets stay locked in sync — `NotesSection` consumes the item-editor type and
 * we'd silently break it if the routine editor added a chrome the notes section doesn't handle.
 */
export type RoutineEditorChrome = ItemEditorChrome;

type EndsMode = 'never' | 'onDate' | 'afterN';

export interface FormState {
    routineType: 'nextAction' | 'calendar';
    title: string;
    rrule: string; // base rrule without UNTIL/COUNT — those are stored in endsMode/endsDate/endsCount
    /** Only meaningful for routineType='nextAction'. See StoredRoutine.recurrenceAnchor. */
    recurrenceAnchor: 'floating' | 'fixed';
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

export function initFormState(routine?: StoredRoutine): FormState {
    const ends = parseEndsFromRrule(routine?.rrule ?? '');
    return {
        routineType: routine?.routineType ?? 'nextAction',
        title: routine?.title ?? '',
        rrule: stripEndClauses(routine?.rrule ?? 'FREQ=DAILY;INTERVAL=1'),
        // Edits: stored value, or derive from the rrule shape when unset (back-compat). New
        // routines default to floating — matches "current implicit behavior when unspecified".
        recurrenceAnchor: routine ? (routine.recurrenceAnchor ?? deriveRecurrenceAnchor(routine.rrule)) : 'floating',
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
 * True when the routine form holds edits that only the explicit Save/Create button would persist —
 * the state the unsaved-changes navigation guard protects. In edit mode title/notes are excluded
 * (they autosave, so navigation can't lose them); in create mode every field counts because
 * nothing persists before Create. Exported for unit-testing.
 */
export function hasUnsavedStructuralRoutineEdits(form: FormState, seed: FormState, isEdit: boolean): boolean {
    return (Object.keys(seed) as Array<keyof FormState>).some((key) => {
        if (isEdit && (key === 'title' || key === 'notes')) {
            return false;
        }
        return JSON.stringify(form[key]) !== JSON.stringify(seed[key]);
    });
}

/** Conflict-notice labels per FormState key. The three Ends fields share one label — they are a
 *  single concept split across inputs, and the conflict list is deduplicated by the caller. */
const ROUTINE_FIELD_LABELS: Record<keyof FormState, string> = {
    routineType: 'Type',
    title: 'Title',
    rrule: 'Frequency',
    recurrenceAnchor: 'Frequency',
    workContextIds: 'Contexts',
    peopleIds: 'People',
    energy: 'Energy',
    time: 'Time estimate',
    focus: 'Focus',
    urgent: 'Urgent',
    notes: 'Notes',
    allDay: 'All-day',
    timeOfDay: 'Start time',
    duration: 'Duration',
    calendarSyncConfigId: 'Calendar',
    endsMode: 'Ends',
    endsDate: 'Ends',
    endsCount: 'Ends',
    startDate: 'Start date',
};

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
    /** Only meaningful for routineType='nextAction'. See StoredRoutine.recurrenceAnchor. */
    recurrenceAnchor?: 'floating' | 'fixed';
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
    if (args.recurrenceAnchor !== undefined && args.recurrenceAnchor !== args.routine.recurrenceAnchor) {
        patch.recurrenceAnchor = args.recurrenceAnchor;
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
    recurrenceAnchor: 'floating' | 'fixed';
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
    /** nextAction analog of `scheduleChanged` — recurrence changed; recomputes the open item's dates instead of regenerating items. */
    nextActionScheduleChanged: boolean;
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
        // recurrenceAnchor is only meaningful for nextAction routines.
        ...(ctx.routineType === 'nextAction' ? { recurrenceAnchor: ctx.recurrenceAnchor } : {}),
    };
    if (!ctx.formStartDate) {
        delete updated.startDate;
    }
    if (ctx.routineType !== 'nextAction') {
        delete updated.recurrenceAnchor;
    }
    if (ctx.routineType !== routine.routineType) {
        // Type switch drops the disconnect-with-keep markers: a later reconnect's strong-key
        // restore would otherwise relink a calendar series onto a non-calendar routine (or a
        // long-dead capped master onto a fresh calendar routine) — the flip-back churn class.
        delete updated.lastKnownCalendarEventId;
        delete updated.lastKnownCalendarIntegrationId;
        delete updated.lastKnownCalendarSyncConfigId;
        delete updated.lastKnownCalendarAccountEmail;
    }
    if (ctx.routineType !== 'calendar') {
        // GCal master-mirror fields are calendar-only — RoutineSnapshotSchema rejects them on a
        // nextAction routine, which would jam the push queue on the first type-switch update op.
        delete updated.organizer;
        delete updated.creator;
        delete updated.attendees;
        delete updated.responseStatus;
        delete updated.eventType;
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
        ...(ctx.routineType === 'nextAction' ? { recurrenceAnchor: ctx.recurrenceAnchor } : {}),
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

/** The before/after pair of an in-place routine edit — the merge baseline and the new truth. */
interface RoutineEditPair {
    previous: StoredRoutine;
    next: StoredRoutine;
}

/**
 * Edit branch: routine.startDate changed. If any past items are done we split (preserve their
 * schedule); otherwise hard-delete the open past items and update in place, then either
 * regenerate future calendar items or restamp/seed the nextAction item (skipping the seed when
 * the new startDate is in the future — the boot-tick will materialise it).
 *
 * Exported for unit-testing.
 */
export async function saveEditWithStartDateChange(db: IDBPDatabase<MyDB>, routine: StoredRoutine, ctx: SaveContext): Promise<OpenItemSyncResult | null> {
    const { donePast, nonDonePast } = await partitionPastItemsByDoneness(db, routine.userId, routine._id);
    if (donePast.length > 0) {
        const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
        await splitRoutine(db, routine.userId, routine, buildSplitPatch(ctx), yesterday);
        return null;
    }
    await hardDeletePastItems(db, nonDonePast);
    const updatedRoutine = buildUpdatedRoutine(routine, ctx, true);
    await updateRoutine(db, updatedRoutine);
    if (routine.routineType !== ctx.routineType) {
        // Type switch + startDate change: the old type's surviving items (a future-dated open
        // nextAction item, or future calendar items) must go before the new type seeds, or the
        // seed guard sees them as the open slot and the streams end up interleaved.
        return transitionRoutineType(db, routine, updatedRoutine, ctx);
    }
    return seedAfterStartDateChange(db, { previous: routine, next: updatedRoutine }, ctx);
}

/**
 * Regenerates calendar items, or syncs the open nextAction item, after a startDate-change update.
 * A surviving open item (hardDeletePastItems only removes PAST ones — a future-dated open item
 * survives) is restamped to the new schedule instead of seeding a duplicate beside it; only when
 * no open item remains is a fresh first item created.
 */
async function seedAfterStartDateChange(db: IDBPDatabase<MyDB>, edit: RoutineEditPair, ctx: SaveContext): Promise<OpenItemSyncResult | null> {
    if (ctx.routineType === 'calendar') {
        await deleteAndRegenerateFutureItems(db, edit.next.userId, edit.next);
        return null;
    }
    const result = await syncOpenItemAfterNextActionEdit(db, { ...edit, scheduleChanged: true });
    if (result.outcome !== 'noOpenItem') {
        return result;
    }
    if (isFutureStartDate(ctx.formStartDate)) {
        return null;
    }
    // A transformed (waitingFor/inbox/…) survivor still claims the routine's single open slot —
    // seeding beside it would surface a visible duplicate. Matches the boot-tick's broad guard.
    if (await hasOpenRoutineItem(db, edit.next.userId, edit.next._id)) {
        return null;
    }
    await seedFirstItemDeactivatingOnExhaustion(db, edit.next);
    return null;
}

/** Seeds the first nextAction item; an exhausted rrule (e.g. Ends date already passed) deactivates
 *  the routine instead of failing the save — same series-over semantics as the disposal path. */
async function seedFirstItemDeactivatingOnExhaustion(db: IDBPDatabase<MyDB>, routine: StoredRoutine): Promise<void> {
    try {
        await createFirstRoutineItem(db, routine.userId, routine);
    } catch (err) {
        if (!(err instanceof RruleExhaustedError)) {
            throw err;
        }
        await updateRoutine(db, { ...routine, active: false });
    }
}

/**
 * Edit branch: routine.startDate unchanged. When the schedule changed AND past items already
 * exist for this routine, split at the computed split date. Otherwise update in place and
 * regenerate calendar items only when needed (schedule changed or resuming from pause).
 *
 * Exported for unit-testing.
 */
export async function saveEditWithoutStartDateChange(db: IDBPDatabase<MyDB>, routine: StoredRoutine, ctx: SaveContext): Promise<OpenItemSyncResult | null> {
    const decision = deriveEditDecision(routine, ctx);
    const hasPastItems = decision.scheduleChanged ? await routineHasPastItems(db, routine.userId, routine._id) : false;
    const splitDate = hasPastItems ? computeSplitDate(routine.rrule, routine.createdTs) : null;
    if (splitDate) {
        await splitRoutine(db, routine.userId, routine, buildSplitPatch(ctx), splitDate);
        return null;
    }
    const updatedRoutine = buildUpdatedRoutine(routine, ctx, decision.resumeOnSave ? true : undefined);
    await updateRoutine(db, updatedRoutine);
    if (routine.routineType === 'calendar' && ctx.routineType === 'calendar') {
        await regenerateCalendarItemsForSameTypeEdit(db, updatedRoutine, decision);
        return null;
    }
    if (routine.routineType === 'nextAction' && ctx.routineType === 'nextAction') {
        return syncOpenItemAfterNextActionEdit(db, {
            previous: routine,
            next: updatedRoutine,
            scheduleChanged: decision.nextActionScheduleChanged,
        });
    }
    return transitionRoutineType(db, routine, updatedRoutine, ctx);
}

/**
 * Type-switch branch (nextAction ↔ calendar) for UNLINKED routines: trash the old type's native
 * items (calendar history keeps its past occurrences — only today-forward items go), then seed the
 * new type's stream. GCal-linked calendar routines never reach here — `dispatchEditSameOwner`
 * routes them through the split gesture so the master series gets capped.
 *
 * Exported for unit-testing.
 */
export async function transitionRoutineType(db: IDBPDatabase<MyDB>, previous: StoredRoutine, updated: StoredRoutine, ctx: SaveContext): Promise<null> {
    await trashNativeItemsForTypeSwitch(db, previous);
    if (ctx.routineType === 'calendar') {
        await generateHorizonDeactivatingOnExhaustion(db, updated);
        return null;
    }
    if (isFutureStartDate(ctx.formStartDate)) {
        return null;
    }
    // A transformed (waitingFor/inbox/…) survivor still claims the routine's single open slot.
    // Deliberately NARROWER than hasOpenRoutineItem: past calendar occurrences stay open-status
    // as history after the switch and must not block the nextAction stream forever.
    if (await hasTransformedSurvivor(db, updated.userId, updated._id)) {
        return null;
    }
    await seedFirstItemDeactivatingOnExhaustion(db, updated);
    return null;
}

/** True when the routine has an open item the USER re-homed (not done/trash/native-calendar). */
async function hasTransformedSurvivor(db: IDBPDatabase<MyDB>, userId: string, routineId: string): Promise<boolean> {
    const items = await db.getAllFromIndex('items', 'userId', userId);
    return items.some((i) => i.routineId === routineId && i.status !== 'done' && i.status !== 'trash' && i.status !== 'calendar');
}

/** Calendar analog of `seedFirstItemDeactivatingOnExhaustion`: an exhausted rrule (no occurrence
 *  before the horizon) deactivates the routine instead of failing the save. */
async function generateHorizonDeactivatingOnExhaustion(db: IDBPDatabase<MyDB>, routine: StoredRoutine): Promise<void> {
    try {
        await generateCalendarItemsToHorizon(db, routine.userId, routine);
    } catch (err) {
        if (!(err instanceof RruleExhaustedError)) {
            throw err;
        }
        await updateRoutine(db, { ...routine, active: false });
    }
}

/**
 * A GCal-linked calendar routine cannot switch type in place: the master series would stay live on
 * Google while the app routine stops being a calendar routine, and the inbound sync (which matches
 * by calendarEventId) would keep rewriting it — the flip-back/churn class. Route the switch through
 * the split gesture instead: the capped head keeps the link and its past items, the head's
 * active→false transition caps the GCal master with UNTIL (existing pause pushback), and the tail
 * is born as the new type. Returns the split date, or null when this edit is not a linked type
 * switch — or when the series has no future occurrence (the Type toggle is disabled for ended
 * calendar routines, so that case is unreachable from the UI).
 *
 * Exported for unit-testing.
 */
export function linkedTypeSwitchSplitDate(routine: StoredRoutine, ctx: SaveContext): string | null {
    if (routine.routineType !== 'calendar' || ctx.routineType === 'calendar' || !routine.calendarEventId) {
        return null;
    }
    return computeSplitDate(routine.rrule, routine.createdTs);
}

/** Computes the `EditDecision` for an edit (schedule-changed + paused→resume). Pure. */
function deriveEditDecision(routine: StoredRoutine, ctx: SaveContext): EditDecision {
    const intent = buildEditIntentFromContext(ctx);
    return {
        scheduleChanged: isCalendarScheduleChanged(routine, intent),
        nextActionScheduleChanged: isNextActionScheduleChanged(routine, intent),
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
        ...(ctx.routineType === 'nextAction' ? { recurrenceAnchor: ctx.recurrenceAnchor } : {}),
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
    /** Picker option pools — scoped to the owner account internally (scopeOptionsToOwner). Callers
     *  that can host a routine whose owner account is visibility-hidden (deep-link pages) must pass
     *  the unfiltered all* sets, or the picker degrades to already-assigned strays only. */
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
    // all* (unfiltered) sets: the live-row lookup and assigned-tag resolution must keep working
    // when this routine's owner account is toggled out of view (editor reached via deep link).
    const { loggedInAccounts, allRoutines, allWorkContexts, allPeople } = useAppData();
    const { runReassignWithOverlay, isPending } = usePendingReassign();

    // Live row — reflects remote sync merges and our own committed autosaves. Every persistence
    // path builds on this (never the mount-time `routine` prop) so a save can't clobber fields
    // another device changed while the editor was open. Undefined in create mode.
    const liveRoutine = routine ? (allRoutines.find((r) => r._id === routine._id) ?? routine) : undefined;
    const liveRoutineRef = useRef(liveRoutine);
    liveRoutineRef.current = liveRoutine;

    const formRef = useRef(form);
    formRef.current = form;
    // Form values last seeded/merged from the live routine — a differing field is "dirty".
    const seedRef = useRef<FormState>(initFormState(routine));
    const [conflictFields, setConflictFields] = useState<string[]>([]);
    // Bumped when a remote rrule is adopted into a clean form — remounts FrequencyPicker (it holds
    // internal state seeded from `value` once, so a silent value change would desync its display).
    const [rruleSeedVersion, setRruleSeedVersion] = useState(0);

    // Title/notes autosave (edit mode only). Schedule/type/template stay on explicit Save — those
    // edits can split the routine or regenerate items, which must never fire per keystroke.
    const textAutosave = useAutosave<{ title: string; notes: string }>({
        initial: { title: routine?.title ?? '', notes: routine?.template.notes ?? '' },
        commit: async (value, baseline) => {
            if (!isEdit || !value.title.trim()) {
                return; // create mode commits via the Create button; a blank title is never persisted
            }
            await persistRoutineText(value);
            offerUndo({
                key: `routine:${routine._id}:text`,
                message: 'Saved',
                undo: async () => {
                    await persistRoutineText(baseline);
                    patch({ title: baseline.title, notes: baseline.notes });
                    textAutosave.reset(baseline);
                },
                onExpire: () => textAutosave.endBurst(),
            });
        },
    });

    /** Writes title/notes onto the live routine (raw, untrimmed — see item editor rationale) and
     *  refreshes future generated items' content, mirroring the explicit-save content-only path. */
    async function persistRoutineText(value: { title: string; notes: string }) {
        const live = liveRoutineRef.current;
        if (!live) {
            return;
        }
        await persistRoutineTextEdit(db, live, value);
        await onSaved();
    }

    // Live merge: adopt remote changes into clean fields; dirty fields keep local edits and flag
    // conflicts (deduplicated labels). Our own autosave echo is recognized via lastCommitted.
    const lastMergedUpdatedTsRef = useRef(routine?.updatedTs);
    useEffect(() => {
        if (!liveRoutine || liveRoutine.updatedTs === lastMergedUpdatedTsRef.current) {
            return;
        }
        lastMergedUpdatedTsRef.current = liveRoutine.updatedTs;
        const incoming = initFormState(liveRoutine);
        const { merged, conflicts } = mergeFormGroup(formRef.current, seedRef.current, incoming, ROUTINE_FIELD_LABELS);
        const committedText = textAutosave.lastCommitted();
        const realConflicts = [
            ...new Set(
                conflicts.filter((label) => {
                    if (label === 'Title') {
                        return incoming.title !== committedText.title;
                    }
                    if (label === 'Notes') {
                        return incoming.notes !== committedText.notes;
                    }
                    return true;
                }),
            ),
        ];
        if (formRef.current.rrule === seedRef.current.rrule && incoming.rrule !== formRef.current.rrule) {
            setRruleSeedVersion((v) => v + 1);
        }
        seedRef.current = incoming;
        setForm(merged);
        if (merged.title === incoming.title && merged.notes === incoming.notes) {
            // Text fully clean/adopted — tighten the baseline. A dirty burst keeps its pending commit.
            textAutosave.reset({ title: incoming.title, notes: incoming.notes });
        }
        if (realConflicts.length > 0) {
            setConflictFields((existing) => [...new Set([...existing, ...realConflicts])]);
        }
    }, [liveRoutine, textAutosave]);

    /** "Use their version": re-seed the whole form from the live routine, dropping local edits. */
    function adoptTheirVersion() {
        const live = liveRoutineRef.current;
        if (!live) {
            return;
        }
        const seeds = initFormState(live);
        seedRef.current = seeds;
        setForm(seeds);
        setOwnerUserId(live.userId);
        textAutosave.reset({ title: seeds.title, notes: seeds.notes });
        setRruleSeedVersion((v) => v + 1);
        setConflictFields([]);
    }
    // Refuse to render the form while a cross-account reassign is in flight on this routine —
    // the form would seed `ownerUserId` from the overlayed (target) user and a save would write
    // IDB under the target. The Dialog wrapper has its own short-circuit (`RoutineDialog.tsx`),
    // but popover/expand/page mount the body directly and need the same guard. Read here, render
    // the guard after all hooks below (rules-of-hooks).
    const reassignInFlight = routine !== undefined && isPending('routine', routine._id);
    const [ownerUserId, setOwnerUserId] = useState<string>(routine?.userId ?? userId);
    const ownerUserIdRef = useRef(ownerUserId);
    ownerUserIdRef.current = ownerUserId;

    // Picker options scoped to the owner account: the merged multi-account sets would otherwise
    // offer another account's identically-named contexts/people — duplicate "anywhere" chips —
    // and allow cross-account tagging on the routine template. Archived entities are hidden,
    // except ids the template already carries (they must stay removable).
    const entityUsage = useEntityUsage();
    const pickerWorkContexts = useMemo(
        () =>
            omitArchived(
                scopeOptionsToOwner(workContexts, { ownerUserId, assignedIds: form.workContextIds, allOptions: allWorkContexts }),
                new Set(form.workContextIds),
            ),
        [workContexts, ownerUserId, form.workContextIds, allWorkContexts],
    );
    const pickerPeople = useMemo(
        () => omitArchived(scopeOptionsToOwner(people, { ownerUserId, assignedIds: form.peopleIds, allOptions: allPeople }), new Set(form.peopleIds)),
        [people, ownerUserId, form.peopleIds, allPeople],
    );

    // ── Unsaved-changes guard ────────────────────────────────────────────────
    // Schedule/type/template edits (and the whole form in create mode) only persist on explicit
    // Save/Create — navigating away or reloading would silently drop them. Pause in-app
    // navigations behind a confirm dialog and arm the native beforeunload prompt meanwhile.
    const guardBypassRef = useRef(false);

    /** Deliberate close (Cancel, post-save) — the navigation it triggers must never re-prompt
     *  about the edits the user just chose to discard or already saved. */
    function closeEditor() {
        guardBypassRef.current = true;
        onClose();
    }

    function hasStructuralEdits(): boolean {
        if (guardBypassRef.current) {
            return false;
        }
        // ownerUserId is seeded from the mount-time routine and only changes via the picker, so a
        // REMOTE reassign of the open routine makes this true without a local edit — one spurious
        // prompt, no data loss. Accepted: the save paths use the same comparison to route saves.
        const live = liveRoutineRef.current;
        if (live && ownerUserIdRef.current !== live.userId) {
            return true;
        }
        return hasUnsavedStructuralRoutineEdits(formRef.current, seedRef.current, isEdit);
    }

    const navigationBlocker = useUnsavedChangesGuard({
        hasUnsavedChanges: hasStructuralEdits,
        // A hard unload also kills a debounced title/notes commit mid-window — the unmount flush
        // that covers in-app navigation never runs on reload/close.
        hasUnsavedChangesOnUnload: () => hasStructuralEdits() || textAutosave.isDirty(),
    });

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
            // Drain any title/notes edit still inside the debounce window so its write can't land
            // after this save with a newer updatedTs and resurrect pre-save structural fields.
            await textAutosave.flush();
            const ctx = buildSaveContext();
            const live = liveRoutineRef.current;
            // Reassign is fire-and-forget: it owns its own onSaved() via runReassignWithOverlay's
            // .then(). Bailing here keeps the outer postlude from double-firing onSaved/onClose
            // before the reassign has actually committed.
            if (live && ownerUserId !== live.userId) {
                dispatchReassign(live, ctx);
                return;
            }
            if (live) {
                // No undo snackbar for structural routine saves in general: a schedule edit may
                // split the routine or delete+regenerate items — restoring a snapshot can't
                // reverse that. The one exception is the exhausted-schedule trash below, which
                // is a single reversible item write and MUST be surfaced explicitly.
                const result = await dispatchEditSameOwner(live, ctx);
                if (result?.outcome === 'trashedExhausted') {
                    offerExhaustedTrashUndo(live._id, result.restorable);
                }
            } else {
                await saveCreate(db, userId, ctx);
            }
            await onSaved();
            closeEditor();
        });

        function buildSaveContext(): SaveContext {
            const finalRrule = buildFinalRrule(form.rrule, form.endsMode, form.endsDate, form.endsCount);
            const calendarLink: CalendarLink = form.routineType === 'calendar' ? resolveCalendarLink(form.calendarSyncConfigId, calendarOptions) : {};
            return {
                trimmedTitle,
                finalRrule,
                recurrenceAnchor: form.recurrenceAnchor,
                routineType: form.routineType,
                template: buildTemplate(form),
                calendarItemTemplate: buildRoutineTemplateFromForm(form),
                calendarLink,
                formStartDate: form.startDate || undefined,
            };
        }

        async function dispatchEditSameOwner(currentRoutine: StoredRoutine, ctx: SaveContext): Promise<OpenItemSyncResult | null> {
            // Linked calendar→nextAction switch goes through the split gesture — see
            // linkedTypeSwitchSplitDate for why an in-place switch is unsafe for GCal-linked routines.
            const linkedSplitDate = linkedTypeSwitchSplitDate(currentRoutine, ctx);
            if (linkedSplitDate) {
                await splitRoutine(db, currentRoutine.userId, currentRoutine, buildSplitPatch(ctx), linkedSplitDate);
                return null;
            }
            if (isStartDateChanged(currentRoutine, buildEditIntentFromContext(ctx))) {
                return saveEditWithStartDateChange(db, currentRoutine, ctx);
            }
            return saveEditWithoutStartDateChange(db, currentRoutine, ctx);
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
                ...(ctx.routineType === 'nextAction' ? { recurrenceAnchor: ctx.recurrenceAnchor } : {}),
                ...(ctx.calendarLink.calendarIntegrationId !== undefined ? { targetIntegrationId: ctx.calendarLink.calendarIntegrationId } : {}),
                ...(ctx.calendarLink.calendarSyncConfigId !== undefined ? { targetSyncConfigId: ctx.calendarLink.calendarSyncConfigId } : {}),
                resumeOnSave: !currentRoutine.active,
            });
            closeEditor();
        }
    }

    /**
     * Explicit snackbar for the exhausted-schedule save: the edited recurrence has no future
     * occurrence, so the pending next action was trashed and the routine deactivated. Undo
     * restores the pending item only — the routine stays inactive because its schedule is
     * genuinely over. Offered before the editor closes; the snackbar is app-global so it
     * survives the close.
     */
    function offerExhaustedTrashUndo(routineId: string, restorable: StoredItem) {
        offerUndo({
            key: `routine:${routineId}:exhaustedTrash`,
            message: 'Schedule ended — the pending next action was moved to trash',
            undo: async () => {
                await restoreTrashedRoutineItem(db, restorable);
                await onSaved();
            },
        });
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
        recurrenceAnchor?: 'floating' | 'fixed';
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
                <ReassignInFlightInline onClose={closeEditor} entityLabel="routine" />
            </Box>
        );
    }

    return (
        <Box className={bodyClassFor(chrome)}>
            {conflictFields.length > 0 && (
                <Alert
                    severity="info"
                    onClose={() => setConflictFields([])}
                    action={
                        <Button color="inherit" size="small" onClick={adoptTheirVersion} data-testid="routineEditorUseTheirs">
                            Use their version
                        </Button>
                    }
                    data-testid="routineEditorConflictNotice"
                >
                    This routine changed on another device ({conflictFields.join(', ')}). Your edits are kept and will overwrite on save.
                </Alert>
            )}
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

            <TextField
                label="Title"
                value={form.title}
                onChange={(e) => {
                    patch({ title: e.target.value });
                    textAutosave.onChange({ title: e.target.value, notes: formRef.current.notes });
                }}
                onBlur={() => void textAutosave.flush()}
                fullWidth
                required
                autoFocus={chrome === 'dialog'}
            />

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
                <FrequencyPicker
                    key={`${routine?._id ?? 'new'}:${rruleSeedVersion}`}
                    value={form.rrule}
                    recurrenceAnchor={form.recurrenceAnchor}
                    onChange={(rrule, recurrenceAnchor) => patch({ rrule, recurrenceAnchor })}
                    disabled={isEndedCalendar}
                />
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
                    workContexts={pickerWorkContexts}
                    people={pickerPeople}
                    usage={entityUsage}
                    onPatch={patch}
                    onToggleWorkContext={toggleWorkContext}
                    onTogglePerson={togglePerson}
                />
            )}

            <NotesSection
                notes={form.notes}
                onNotesChange={(notes) => {
                    patch({ notes });
                    textAutosave.onChange({ title: formRef.current.title, notes });
                }}
                chrome={chrome}
            />

            {/* Account picker — auto-hides on single-account devices */}
            {loggedInAccounts.length > 1 && <AccountPicker value={ownerUserId} onChange={setOwnerUserId} disabled={isSaving} />}

            {chrome === 'dialog' ? (
                <DialogActions sx={{ px: 0 }}>
                    <Button onClick={closeEditor}>Cancel</Button>
                    <Button variant="contained" disabled={saveDisabled} onClick={() => onSave()} data-testid="routineEditorSaveButton">
                        {isEdit ? 'Save changes' : 'Create routine'}
                    </Button>
                </DialogActions>
            ) : (
                <Box className={styles.inlineActions}>
                    <Button onClick={closeEditor}>Cancel</Button>
                    <Button variant="contained" disabled={saveDisabled} onClick={() => onSave()} data-testid="routineEditorSaveButton">
                        {isEdit ? 'Save changes' : 'Create routine'}
                    </Button>
                </Box>
            )}
            <UnsavedChangesDialog blocker={navigationBlocker} />
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
    /** Ranks the chip clouds most-used-first and drives their collapse (see CollapsibleChipGroup). */
    usage: UsageIndex;
    onPatch: (patch: Partial<FormState>) => void;
    onToggleWorkContext: (id: string) => void;
    onTogglePerson: (id: string) => void;
}

function TemplateFields({ form, workContexts, people, usage, onPatch, onToggleWorkContext, onTogglePerson }: TemplateFieldsProps) {
    // Memoized like NextActionFields — without these every keystroke in the surrounding form
    // re-sorts both chip clouds.
    const rankedContexts = useMemo(() => rankByUsage(workContexts, usage.contexts), [workContexts, usage.contexts]);
    const alphabeticalContexts = useMemo(() => sortByName(workContexts), [workContexts]);
    const rankedPeople = useMemo(() => rankByUsage(people, usage.people), [people, usage.people]);
    const alphabeticalPeople = useMemo(() => sortByName(people), [people]);
    const selectedContextIds = useMemo(() => new Set(form.workContextIds), [form.workContextIds]);
    const selectedPeopleIds = useMemo(() => new Set(form.peopleIds), [form.peopleIds]);
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
                    <CollapsibleChipGroup
                        ranked={rankedContexts}
                        alphabetical={alphabeticalContexts}
                        selectedIds={selectedContextIds}
                        keyOf={(ctx) => ctx._id}
                        testId="routineTemplateWorkContextChip"
                        sx={{ mt: 0.5 }}
                        renderChip={(ctx) => (
                            <Chip
                                label={ctx.name}
                                data-testid="routineTemplateWorkContextChip"
                                size="small"
                                variant={form.workContextIds.includes(ctx._id) ? 'filled' : 'outlined'}
                                color={form.workContextIds.includes(ctx._id) ? 'primary' : 'default'}
                                onClick={() => onToggleWorkContext(ctx._id)}
                            />
                        )}
                    />
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
                    <CollapsibleChipGroup
                        ranked={rankedPeople}
                        alphabetical={alphabeticalPeople}
                        selectedIds={selectedPeopleIds}
                        keyOf={(p) => p._id}
                        testId="routineTemplatePersonChip"
                        sx={{ mt: 0.5 }}
                        renderChip={(p) => (
                            <Chip
                                label={p.name}
                                data-testid="routineTemplatePersonChip"
                                size="small"
                                variant={form.peopleIds.includes(p._id) ? 'filled' : 'outlined'}
                                color={form.peopleIds.includes(p._id) ? 'primary' : 'default'}
                                onClick={() => onTogglePerson(p._id)}
                            />
                        )}
                    />
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
