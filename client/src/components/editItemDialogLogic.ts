import dayjs from 'dayjs';
import type { CalendarOption } from '../hooks/useCalendarOptions';
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
