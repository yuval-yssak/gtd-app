import dayjs from 'dayjs';
import type { ReassignItemEditPatch } from '../api/syncApi';
import type { CalendarOption } from '../hooks/useCalendarOptions';
import { hasAtLeastOne } from '../lib/typeUtils';
import type { EnergyLevel, StoredItem } from '../types/MyDB';
import type { CalendarFormState, NextActionFormState, SomedayMaybeFormState, WaitingForFormState } from './clarify/types';
import { buildCalendarMeta, type CalendarMeta } from './clarify/types';

export type EditableStatus = 'inbox' | 'nextAction' | 'calendar' | 'waitingFor' | 'somedayMaybe' | 'done' | 'trash';

/** The four per-status form states the editor maintains, bundled so the merge/patch builders take
 *  one cohesive "editor forms" argument instead of a growing list of positional form params. */
export interface EditorForms {
    na: NextActionFormState;
    cal: CalendarFormState;
    wf: WaitingForFormState;
    sm: SomedayMaybeFormState;
}

export type ItemEditorChrome = 'dialog' | 'popover' | 'expand' | 'page';

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

/** Returns true when the selected status requires a field that isn't filled in the form.
 *  Only calendar (date/time validity) and a non-empty title gate the save — every other status,
 *  including waitingFor (the person is optional) and somedayMaybe, has no required field. */
export function isSaveDisabled(title: string, status: EditableStatus, cal: CalendarFormState): boolean {
    if (!title.trim()) {
        return true;
    }
    if (status === 'calendar' && !cal.date) {
        return true;
    }
    // YYYY-MM-DD strings (from <input type="date">) sort lexicographically. Block save when the
    // user enters an all-day end date before the start date; without this guard buildCalendarMeta's
    // clamp silently coerces the bad range to a single-day event with zero visible feedback.
    if (status === 'calendar' && cal.allDay && cal.endDate && cal.endDate < cal.date) {
        return true;
    }
    // Zero-padded HH:mm strings (from <input type="time">) compare lexicographically the same as
    // numerically, so a string compare is sufficient to detect end-before-start on the same date.
    if (status === 'calendar' && !cal.allDay && cal.startTime && cal.endTime && cal.endTime < cal.startTime) {
        return true;
    }
    // waitingFor has no required field — the person is optional, so the only gate is a non-empty title.
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
 * date changes shift both endpoints together and need no special handling. The duration-preserve
 * trick only applies to timed events — all-day events use endDate, not endTime, and never need it.
 */
export function applyCalendarPatch(prev: CalendarFormState, patch: Partial<CalendarFormState>): CalendarFormState {
    const next = { ...prev, ...patch };
    if (next.allDay) {
        return next;
    }
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
 *
 * Preservation rule: when the form still names the same configId the item already carries, the
 * existing link IDs are preserved even if `calendarOptions` resolved empty (fetch failed, or no
 * integrations connected). Otherwise that empty-options state would silently drop both link IDs
 * from a linked GCal item, leaving server-side pushback unable to resolve a push context (the
 * bug that left edits invisible to GCal). Only an explicit switch to "Default" or to a different
 * option clears the link.
 */
export function applyCalendarForm(item: StoredItem, cal: CalendarFormState, calendarOptions: CalendarOption[]): StoredItem {
    const meta: CalendarMeta = buildCalendarMeta(cal, calendarOptions);
    // Strip `allDay` alongside the calendar-link keys so meta controls the final value — never leave
    // a stale `true` from a prior all-day save when the user toggled back to timed.
    const { calendarSyncConfigId: _csc, calendarIntegrationId: _ci, allDay: _ad, ...rest } = item;
    const link = pickLinkForInPlaceEdit(item, cal, meta);
    return { ...rest, timeStart: meta.timeStart, timeEnd: meta.timeEnd, ...(meta.allDay ? { allDay: true } : {}), ...link };
}

/** Either both link IDs together (paired link) or neither (cleared). The discriminated shape
 *  prevents callers from spreading a half-set link onto an item. */
type CalendarLink = { calendarSyncConfigId: string; calendarIntegrationId: string } | Record<string, never>;

/**
 * Picks which (configId, integrationId) pair to write back onto the item during an in-place edit.
 * - Meta resolved a real option → use it (covers picker change, fresh selection, reassign).
 * - Form still names the same configId the item already carries → preserve the existing IDs
 *   (covers the empty-options race that was silently dropping the link on save).
 * - Otherwise → clear (form switched to "Default", or to a configId the item never had).
 */
function pickLinkForInPlaceEdit(item: StoredItem, cal: CalendarFormState, meta: CalendarMeta): CalendarLink {
    if (meta.calendarSyncConfigId && meta.calendarIntegrationId) {
        return { calendarSyncConfigId: meta.calendarSyncConfigId, calendarIntegrationId: meta.calendarIntegrationId };
    }
    if (cal.calendarSyncConfigId && cal.calendarSyncConfigId === item.calendarSyncConfigId && item.calendarIntegrationId) {
        return { calendarSyncConfigId: item.calendarSyncConfigId, calendarIntegrationId: item.calendarIntegrationId };
    }
    return {};
}

export function applyWaitingForForm(item: StoredItem, wf: WaitingForFormState): StoredItem {
    const { waitingForPersonId: _wfp, expectedBy: _eb, ignoreBefore: _ib, ...rest } = item;
    return {
        ...rest,
        // Omit waitingForPersonId when blank — the person is optional and a '' would fail the op
        // validator's NonEmptyString rule.
        ...(wf.waitingForPersonId ? { waitingForPersonId: wf.waitingForPersonId } : {}),
        ...(wf.expectedBy ? { expectedBy: wf.expectedBy } : {}),
        ...(wf.ignoreBefore ? { ignoreBefore: wf.ignoreBefore } : {}),
    };
}

export function applySomedayMaybeForm(item: StoredItem, sm: SomedayMaybeFormState): StoredItem {
    const { expectedBy: _eb, ignoreBefore: _ib, ...rest } = item;
    return {
        ...rest,
        ...(sm.expectedBy ? { expectedBy: sm.expectedBy } : {}),
        ...(sm.ignoreBefore ? { ignoreBefore: sm.ignoreBefore } : {}),
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
    forms: EditorForms,
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
        addCalendarPatchFields(patch, item, forms.cal);
    }
    if (status === 'nextAction') {
        addNextActionPatchFields(patch, item, forms.na);
    }
    if (status === 'waitingFor') {
        addWaitingForPatchFields(patch, item, forms.wf);
    }
    if (status === 'somedayMaybe') {
        addSomedayMaybePatchFields(patch, item, forms.sm);
    }
    return patch;
}

/**
 * Calendar wall-clock changes flow into timeStart/timeEnd; the all-day flag rides as `allDay`.
 * The configId is NOT in the patch — see buildEditPatch. Branches on `cal.allDay`:
 *   - All-day → emits YYYY-MM-DD timeStart and a +1-day exclusive timeEnd; tracks `allDay` only
 *     when it differs from the item's current flag (toggling the switch is itself a meaningful diff).
 *   - Timed → existing wall-clock behavior; tracks `allDay: false` when the item was previously all-day.
 */
function addCalendarPatchFields(patch: ReassignItemEditPatch, item: StoredItem, cal: CalendarFormState): void {
    if (!cal.date) {
        return;
    }
    const wasAllDay = item.allDay === true;
    if (cal.allDay) {
        addAllDayCalendarPatchFields(patch, item, cal);
        if (!wasAllDay) {
            patch.allDay = true;
        }
        return;
    }
    if (!cal.startTime || !cal.endTime) {
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
    if (wasAllDay) {
        patch.allDay = false;
    }
}

/** Emits timeStart / timeEnd for an all-day form when they differ from the item's stored YYYY-MM-DD strings. */
function addAllDayCalendarPatchFields(patch: ReassignItemEditPatch, item: StoredItem, cal: CalendarFormState): void {
    const inclusiveEnd = cal.endDate && cal.endDate >= cal.date ? cal.endDate : cal.date;
    const nextEnd = dayjs(inclusiveEnd).add(1, 'day').format('YYYY-MM-DD');
    if (cal.date !== item.timeStart) {
        patch.timeStart = cal.date;
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
        // Empty string is the clear sentinel the PATCH route understands — emit it so removing the
        // person on an item that had one actually unsets the field.
        patch.waitingForPersonId = wf.waitingForPersonId;
    }
    if (wf.expectedBy !== (item.expectedBy ?? '')) {
        patch.expectedBy = wf.expectedBy;
    }
    if (wf.ignoreBefore !== (item.ignoreBefore ?? '')) {
        patch.ignoreBefore = wf.ignoreBefore;
    }
}

function addSomedayMaybePatchFields(patch: ReassignItemEditPatch, item: StoredItem, sm: SomedayMaybeFormState): void {
    if (sm.expectedBy !== (item.expectedBy ?? '')) {
        patch.expectedBy = sm.expectedBy;
    }
    if (sm.ignoreBefore !== (item.ignoreBefore ?? '')) {
        patch.ignoreBefore = sm.ignoreBefore;
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

export function mergeFormsIntoItem(item: StoredItem, status: EditableStatus, forms: EditorForms, calendarOptions: CalendarOption[]): StoredItem {
    if (status === 'nextAction') {
        return applyNextActionForm(item, forms.na);
    }
    if (status === 'calendar') {
        return applyCalendarForm(item, forms.cal, calendarOptions);
    }
    if (status === 'waitingFor') {
        return applyWaitingForForm(item, forms.wf);
    }
    if (status === 'somedayMaybe') {
        return applySomedayMaybeForm(item, forms.sm);
    }
    // inbox, done, trash — no extra fields beyond title/notes
    return item;
}

/**
 * Whether the title input should auto-focus on mount for the given chrome/initialStatus.
 * - dialog: yes — modal opened to be edited.
 * - page: no — page mode is read-mostly; auto-focus pins the cursor at the end of long titles
 *   and scrolls the start out of view.
 * - expand/popover: yes only when the user explicitly chose a destination via a chip (initialStatus
 *   set). Row-body-click expands shouldn't yank focus from the row.
 */
export function shouldAutoFocusTitle(chrome: ItemEditorChrome, initialStatus: EditableStatus | undefined): boolean {
    if (chrome === 'dialog') {
        return true;
    }
    if (chrome === 'page') {
        return false;
    }
    return initialStatus !== undefined;
}

/** True when notes are blank or whitespace-only. The page-mode notes section uses this to decide
 *  both the initial preview/editor state (start in editor when empty so the affordance is obvious)
 *  and the blur behaviour (stay in editor when empty so the user can resume typing). */
export function notesAreEmpty(notes: string): boolean {
    return notes.trim().length === 0;
}

/**
 * Builds the optional `opts` argument for `clarifyToDone` so the spread in `ItemEditorBody`'s
 * status-transition dispatch is a named helper instead of an inline ternary. `exactOptionalPropertyTypes`
 * forbids passing `{ onReadOnlyGCal: undefined }`, so when no callback is supplied we must pass
 * `undefined` for the entire opts arg. Extracted into a pure helper so a future refactor that
 * accidentally drops the prop-forwarding has to also delete a named, tested call — much harder
 * to do silently than removing an inline ternary spread.
 */
export function buildClarifyToDoneOpts(onReadOnly: (() => void) | undefined): { onReadOnlyGCal: () => void } | undefined {
    return onReadOnly ? { onReadOnlyGCal: onReadOnly } : undefined;
}
