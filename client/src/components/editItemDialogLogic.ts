import dayjs from 'dayjs';
import type { ReassignItemEditPatch } from '../api/syncApi';
import type { CalendarOption } from '../hooks/useCalendarOptions';
import { hasAtLeastOne } from '../lib/typeUtils';
import type { EnergyLevel, StoredItem } from '../types/MyDB';
import type { CalendarFormState, NextActionFormState, WaitingForFormState } from './clarify/types';
import { buildCalendarMeta, type CalendarMeta } from './clarify/types';

export type EditableStatus = 'inbox' | 'nextAction' | 'calendar' | 'waitingFor' | 'somedayMaybe' | 'done' | 'trash';

/** Drops routineId so a routine-generated calendar item can leave the routine's series without resurfacing. */
export function stripRoutineId(item: StoredItem): StoredItem {
    // Cast is required because TypeScript does not remove the optional `routineId` field from the
    // rest type — but the runtime object has no such key, so treating it as StoredItem is sound.
    const { routineId: _rid, ...rest } = item;
    return rest as StoredItem;
}

/**
 * Decides whether a status change should detach the item from its routine.
 * Only detach when moving out of `calendar` into another live in-list status —
 * done and trash MUST keep routineId so the disposal path records a skipped exception
 * or advances the series. Otherwise the trashed date silently regenerates.
 */
export function shouldDetachFromRoutine(previous: EditableStatus, next: EditableStatus, hasRoutineId: boolean): boolean {
    if (!hasRoutineId) {
        return false;
    }
    if (previous !== 'calendar' || next === 'calendar') {
        return false;
    }
    return next !== 'done' && next !== 'trash';
}

/** Returns true when the selected status requires a field that isn't filled in the form. */
export function isSaveDisabled(title: string, status: EditableStatus, cal: CalendarFormState, wf: WaitingForFormState): boolean {
    if (!title.trim()) {
        return true;
    }
    if (status === 'calendar' && !cal.date) {
        return true;
    }
    // Zero-padded HH:mm strings (from <input type="time">) compare lexicographically the same as
    // numerically, so a string compare is sufficient to detect end-before-start on the same date.
    if (status === 'calendar' && cal.startTime && cal.endTime && cal.endTime < cal.startTime) {
        return true;
    }
    if (status === 'waitingFor' && !wf.waitingForPersonId) {
        return true;
    }
    return false;
}

/**
 * Produces a normalized item snapshot with the edited title applied and notes either set (when
 * non-empty) or omitted entirely (when blank). The notes omission matters because
 * `exactOptionalPropertyTypes` requires missing keys rather than undefined, and the sync server
 * uses the same shape as the conflict-resolution anchor.
 */
export function normalizeTitleAndNotes(item: StoredItem, trimmedTitle: string, trimmedNotes: string): StoredItem {
    const { notes: _n, ...rest } = item;
    const withTitle: StoredItem = { ...rest, title: trimmedTitle };
    return trimmedNotes ? { ...withTitle, notes: trimmedNotes } : withTitle;
}

/**
 * Merges the active status's form state into the item for in-place updates (no status change).
 * Callers branch on status before invoking the matching helper; a single argument bag keeps the
 * call site terse and makes it obvious which form is consumed.
 */
export function applyNextActionForm(item: StoredItem, na: NextActionFormState): StoredItem {
    const { workContextIds: _wc, peopleIds: _pi, energy: _e, time: _t, urgent: _u, focus: _f, expectedBy: _eb, ignoreBefore: _ib, ...rest } = item;
    return {
        ...rest,
        ...(na.workContextIds.length ? { workContextIds: na.workContextIds } : {}),
        ...(na.peopleIds.length ? { peopleIds: na.peopleIds } : {}),
        ...(na.energy ? { energy: na.energy as EnergyLevel } : {}),
        ...(na.time ? { time: Number(na.time) } : {}),
        ...(na.urgent ? { urgent: true } : {}),
        ...(na.focus ? { focus: true } : {}),
        ...(na.expectedBy ? { expectedBy: na.expectedBy } : {}),
        ...(na.ignoreBefore ? { ignoreBefore: na.ignoreBefore } : {}),
    };
}

/**
 * Returns the new HH:mm `endTime` that preserves the duration `prevEnd - prevStart` after the start
 * moves to `nextStart`. Returns null when the inputs are unparseable, the prior duration is
 * negative, or the shifted end would wrap past midnight (the form is single-date).
 */
function shiftEndKeepingDuration(prevStart: string, prevEnd: string, nextStart: string): string | null {
    const start = dayjs(`2000-01-01T${prevStart}`);
    const end = dayjs(`2000-01-01T${prevEnd}`);
    const next = dayjs(`2000-01-01T${nextStart}`);
    const durationMinutes = end.diff(start, 'minute');
    if (durationMinutes < 0 || !next.isValid()) {
        return null;
    }
    const shifted = next.add(durationMinutes, 'minute');
    return shifted.isSame(next, 'day') ? shifted.format('HH:mm') : null;
}

/**
 * Applies a partial calendar-form edit while preserving the existing duration when the user moves
 * the start time. Editing `endTime` directly is the explicit "change the duration" gesture, so end
 * is left untouched in that case. Same-day events only — the form has a single `date` field, so
 * date changes shift both endpoints together and need no special handling.
 */
export function applyCalendarPatch(prev: CalendarFormState, patch: Partial<CalendarFormState>): CalendarFormState {
    const next = { ...prev, ...patch };
    if (patch.startTime === undefined || patch.startTime === prev.startTime || !prev.startTime || !prev.endTime) {
        return next;
    }
    const shiftedEnd = shiftEndKeepingDuration(prev.startTime, prev.endTime, patch.startTime);
    return shiftedEnd ? { ...next, endTime: shiftedEnd } : next;
}

/**
 * In-place calendar edit. Strips stale calendar-target IDs before reapplying — mirrors
 * clarifyToCalendar so switching the picker back to "Default" (empty meta) actually clears a
 * previously-selected config rather than silently preserving the old one. `calendarEventId`,
 * `lastPushedToGCalTs`, and `routineId` survive via `...rest` so outbound push still sees this
 * as an existing-event edit.
 */
export function applyCalendarForm(item: StoredItem, cal: CalendarFormState, calendarOptions: CalendarOption[]): StoredItem {
    const meta: CalendarMeta = buildCalendarMeta(cal, calendarOptions);
    const { calendarSyncConfigId: _csc, calendarIntegrationId: _ci, ...rest } = item;
    return {
        ...rest,
        timeStart: meta.timeStart,
        timeEnd: meta.timeEnd,
        ...(meta.calendarSyncConfigId ? { calendarSyncConfigId: meta.calendarSyncConfigId } : {}),
        ...(meta.calendarIntegrationId ? { calendarIntegrationId: meta.calendarIntegrationId } : {}),
    };
}

export function applyWaitingForForm(item: StoredItem, wf: WaitingForFormState): StoredItem {
    const { waitingForPersonId: _wfp, expectedBy: _eb, ignoreBefore: _ib, ...rest } = item;
    return {
        ...rest,
        waitingForPersonId: wf.waitingForPersonId,
        ...(wf.expectedBy ? { expectedBy: wf.expectedBy } : {}),
        ...(wf.ignoreBefore ? { ignoreBefore: wf.ignoreBefore } : {}),
    };
}

/**
 * Picks which calendarSyncConfigId to pre-fill when the dialog's owner switches to `userId`.
 * - Switching back to the item's original owner restores the item's original configId.
 * - Switching to a different owner pre-selects that account's default calendar; falls back to its
 *   sole calendar when there's exactly one. Otherwise returns '' so the user is forced to choose.
 *
 * Without this, the previously-picked configId belongs to the source account and is filtered out
 * of the picker when the owner changes — leaving the Select rendered empty and failing
 * validateReassign on save with "Pick a calendar from {email} before saving" but no way to satisfy it.
 */
export function pickDefaultConfigForUser(calendarOptions: CalendarOption[], userId: string, item: StoredItem): string {
    if (userId === item.userId) {
        return item.calendarSyncConfigId ?? '';
    }
    const ownedByTarget = calendarOptions.filter((opt) => opt.userId === userId);
    const defaultOption = ownedByTarget.find((opt) => opt.isDefault);
    if (defaultOption) {
        return defaultOption.configId;
    }
    if (hasAtLeastOne(ownedByTarget) && ownedByTarget.length === 1) {
        return ownedByTarget[0].configId;
    }
    return '';
}

/**
 * Discriminated path the dialog's Save button takes for a given (ownerChanged, statusChanged) pair.
 * Centralised here so the rule can be unit-tested without rendering — guards against regressions
 * to the "ownerChanged → never write under source user" invariant that the old buggy flow violated.
 */
export type SavePath = { kind: 'reassign' } | { kind: 'statusTransition' } | { kind: 'saveInPlace' } | { kind: 'block'; error: string };

export function decideSavePath(ownerChanged: boolean, statusChanged: boolean): SavePath {
    if (ownerChanged && statusChanged) {
        return { kind: 'block', error: 'Change either the status or the account, not both, in a single save.' };
    }
    if (ownerChanged) {
        return { kind: 'reassign' };
    }
    if (statusChanged) {
        return { kind: 'statusTransition' };
    }
    return { kind: 'saveInPlace' };
}

/**
 * Diffs the dialog's form state against the original item and returns a patch containing only
 * fields the user actually changed. Used by the cross-account reassign flow to ship edits along
 * with the move in a single atomic /sync/reassign call — without writing the source-user copy
 * first (which would silently corrupt data when the active session is the target).
 *
 * Empty string ('') and empty array ([]) are the server's "clear this field" sentinels; the
 * helper emits them only when the original had a value and the form now has none, so a clear
 * action distinguishes from an unchanged-empty field.
 *
 * Calendar refs (calendarSyncConfigId / calendarIntegrationId / calendarEventId) are NOT in
 * the patch — those are conveyed via `targetCalendar` on the reassign call instead.
 */
export function buildEditPatch(
    item: StoredItem,
    trimmedTitle: string,
    trimmedNotes: string,
    status: EditableStatus,
    na: NextActionFormState,
    cal: CalendarFormState,
    wf: WaitingForFormState,
): ReassignItemEditPatch {
    const patch: ReassignItemEditPatch = {};
    if (trimmedTitle !== item.title) {
        patch.title = trimmedTitle;
    }
    const originalNotes = item.notes ?? '';
    if (trimmedNotes !== originalNotes) {
        patch.notes = trimmedNotes;
    }
    if (status === 'calendar') {
        addCalendarPatchFields(patch, item, cal);
    }
    if (status === 'nextAction') {
        addNextActionPatchFields(patch, item, na);
    }
    if (status === 'waitingFor') {
        addWaitingForPatchFields(patch, item, wf);
    }
    return patch;
}

/** Calendar wall-clock changes flow into timeStart/timeEnd. The configId is NOT in the patch — see buildEditPatch. */
function addCalendarPatchFields(patch: ReassignItemEditPatch, item: StoredItem, cal: CalendarFormState): void {
    if (!cal.date || !cal.startTime || !cal.endTime) {
        return;
    }
    const nextStart = dayjs(`${cal.date}T${cal.startTime}`).toISOString();
    const nextEnd = dayjs(`${cal.date}T${cal.endTime}`).toISOString();
    if (nextStart !== item.timeStart) {
        patch.timeStart = nextStart;
    }
    if (nextEnd !== item.timeEnd) {
        patch.timeEnd = nextEnd;
    }
}

/** Each nextAction field maps 1:1 from form state to a patch key when changed. */
function addNextActionPatchFields(patch: ReassignItemEditPatch, item: StoredItem, na: NextActionFormState): void {
    const originalContexts = item.workContextIds ?? [];
    if (!arraysSetEqual(na.workContextIds, originalContexts)) {
        patch.workContextIds = na.workContextIds;
    }
    const originalPeople = item.peopleIds ?? [];
    if (!arraysSetEqual(na.peopleIds, originalPeople)) {
        patch.peopleIds = na.peopleIds;
    }
    const originalEnergy = item.energy ?? '';
    if (na.energy !== originalEnergy) {
        // '' is the server's "clear this field" sentinel — emit it explicitly so the move drops
        // a previously-set energy. Server's whitelist accepts '' here too.
        patch.energy = na.energy === '' ? '' : (na.energy as EnergyLevel);
    }
    const originalTime = item.time?.toString() ?? '';
    if (na.time !== originalTime) {
        // Same '' clear sentinel for the numeric time estimate.
        patch.time = na.time === '' ? '' : Number(na.time);
    }
    if (na.urgent !== Boolean(item.urgent)) {
        patch.urgent = na.urgent;
    }
    if (na.focus !== Boolean(item.focus)) {
        patch.focus = na.focus;
    }
    if (na.expectedBy !== (item.expectedBy ?? '')) {
        patch.expectedBy = na.expectedBy;
    }
    if (na.ignoreBefore !== (item.ignoreBefore ?? '')) {
        patch.ignoreBefore = na.ignoreBefore;
    }
}

function addWaitingForPatchFields(patch: ReassignItemEditPatch, item: StoredItem, wf: WaitingForFormState): void {
    if (wf.waitingForPersonId !== (item.waitingForPersonId ?? '')) {
        patch.waitingForPersonId = wf.waitingForPersonId;
    }
    if (wf.expectedBy !== (item.expectedBy ?? '')) {
        patch.expectedBy = wf.expectedBy;
    }
    if (wf.ignoreBefore !== (item.ignoreBefore ?? '')) {
        patch.ignoreBefore = wf.ignoreBefore;
    }
}

/**
 * Set-equality on two string arrays — the dialog's chip toggle doesn't preserve the original
 * storage order, so order-sensitive comparison would emit phantom diffs whenever a user
 * unticks-then-reticks the same chip.
 */
function arraysSetEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) {
        return false;
    }
    const setA = new Set(a);
    return b.every((v) => setA.has(v));
}

export function mergeFormsIntoItem(
    item: StoredItem,
    status: EditableStatus,
    na: NextActionFormState,
    cal: CalendarFormState,
    wf: WaitingForFormState,
    calendarOptions: CalendarOption[],
): StoredItem {
    if (status === 'nextAction') {
        return applyNextActionForm(item, na);
    }
    if (status === 'calendar') {
        return applyCalendarForm(item, cal, calendarOptions);
    }
    if (status === 'waitingFor') {
        return applyWaitingForForm(item, wf);
    }
    // inbox, somedayMaybe, done, trash — no extra fields beyond title/notes
    return item;
}
