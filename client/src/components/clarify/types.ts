import dayjs from 'dayjs';
import type { CalendarMeta } from '../../db/itemMutations';
import type { CalendarOption } from '../../hooks/useCalendarOptions';
import { toGCalExclusive } from '../../lib/allDayDate';
import type { EnergyLevel } from '../../types/MyDB';

// Re-export `CalendarMeta` so callers that already import `buildCalendarMeta` from this module
// can pull the related type without reaching into `db/itemMutations`.
export type { CalendarMeta };

export type Destination = 'nextAction' | 'calendar' | 'waitingFor' | 'done' | 'trash';

export interface NextActionFormState {
    // ignoreBefore listed first — the form renders it at the top as the tickler field
    ignoreBefore: string;
    workContextIds: string[];
    peopleIds: string[];
    energy: EnergyLevel | '';
    time: string;
    urgent: boolean;
    focus: boolean;
    expectedBy: string;
}

export const emptyNextAction: NextActionFormState = {
    ignoreBefore: '',
    workContextIds: [],
    peopleIds: [],
    energy: '',
    time: '',
    urgent: false,
    focus: false,
    expectedBy: '',
};

export interface CalendarFormState {
    date: string;
    startTime: string;
    endTime: string;
    /** Sync config ID for the target calendar. Empty string = use default. */
    calendarSyncConfigId: string;
    /** When true, the event is all-day — startTime/endTime are ignored and endDate is consulted. */
    allDay: boolean;
    /**
     * Inclusive (user-visible) end date for all-day events. Empty string = single-day (end = start).
     * Stored inclusive so the input renders the date the user actually picked; converted to GCal's
     * exclusive end at save time by buildCalendarMeta via toGCalExclusive.
     */
    endDate: string;
}

export const emptyCalendar: CalendarFormState = { date: '', startTime: '', endTime: '', calendarSyncConfigId: '', allDay: false, endDate: '' };

export interface WaitingForFormState {
    waitingForPersonId: string;
    expectedBy: string;
    ignoreBefore: string;
}

export const emptyWaitingFor: WaitingForFormState = { waitingForPersonId: '', expectedBy: '', ignoreBefore: '' };

// Someday/Maybe carries the same two deferral dates as waitingFor (no person, no schedule).
export interface SomedayMaybeFormState {
    expectedBy: string;
    ignoreBefore: string;
}

export const emptySomedayMaybe: SomedayMaybeFormState = { expectedBy: '', ignoreBefore: '' };

// ── Meta builders ─────────────────────────────────────────────────────────────
// These convert form state into the shape expected by the clarify mutations.
// exactOptionalPropertyTypes: omit undefined keys rather than assigning them.

export function buildNextActionMeta(form: NextActionFormState) {
    return {
        ...(form.workContextIds.length && { workContextIds: form.workContextIds }),
        ...(form.peopleIds.length && { peopleIds: form.peopleIds }),
        ...(form.energy && { energy: form.energy }),
        ...(form.time && { time: Number(form.time) }),
        ...(form.urgent && { urgent: form.urgent }),
        ...(form.focus && { focus: form.focus }),
        ...(form.expectedBy && { expectedBy: form.expectedBy }),
        ...(form.ignoreBefore && { ignoreBefore: form.ignoreBefore }),
    };
}

/**
 * Converts calendar form state into the meta object expected by clarifyToCalendar.
 * Branches on `allDay`:
 *   - All-day → emits YYYY-MM-DD `timeStart` and a +1-day exclusive `timeEnd` (GCal convention).
 *     Multi-day comes from `endDate` (inclusive in the form), which is also +1-day shifted.
 *     A blank `endDate` or one earlier than `date` collapses to a single-day event — the form
 *     can never store a negative-duration all-day range.
 *   - Timed → existing behavior: combines date + startTime into an ISO datetime; falls back to
 *     start + 1h when endTime is missing.
 */
export function buildCalendarMeta(form: CalendarFormState, calendarOptions: CalendarOption[]): CalendarMeta {
    const selectedOption = calendarOptions.find((o) => o.configId === form.calendarSyncConfigId);
    const linkOptions = selectedOption ? { calendarSyncConfigId: selectedOption.configId, calendarIntegrationId: selectedOption.integrationId } : {};
    if (form.allDay) {
        return { ...buildAllDayCalendarMeta(form), ...linkOptions };
    }
    return { ...buildTimedCalendarMeta(form), ...linkOptions };
}

function buildAllDayCalendarMeta(form: CalendarFormState): Pick<CalendarMeta, 'timeStart' | 'timeEnd' | 'allDay'> {
    const start = form.date || dayjs().format('YYYY-MM-DD');
    // Clamp invalid endDate (blank, or earlier than start) to a single-day event — the form has no
    // way to express a negative range, so silently coercing is friendlier than refusing to save.
    const inclusiveEnd = form.endDate && form.endDate >= start ? form.endDate : start;
    return { timeStart: start, timeEnd: toGCalExclusive(inclusiveEnd), allDay: true };
}

function buildTimedCalendarMeta(form: CalendarFormState): Pick<CalendarMeta, 'timeStart' | 'timeEnd'> {
    const startIso = form.date ? dayjs(`${form.date}${form.startTime ? `T${form.startTime}` : ''}`).toISOString() : dayjs().toISOString();
    const endIso = form.date && form.endTime ? dayjs(`${form.date}T${form.endTime}`).toISOString() : dayjs(startIso).add(1, 'hour').toISOString();
    return { timeStart: startIso, timeEnd: endIso };
}

export function buildWaitingForMeta(form: WaitingForFormState) {
    return {
        // The person is optional — omit the key entirely when unset so a blank string never reaches
        // the snapshot (the op validator requires a NonEmptyString when the field is present).
        ...(form.waitingForPersonId && { waitingForPersonId: form.waitingForPersonId }),
        ...(form.expectedBy && { expectedBy: form.expectedBy }),
        ...(form.ignoreBefore && { ignoreBefore: form.ignoreBefore }),
    };
}

export function buildSomedayMaybeMeta(form: SomedayMaybeFormState) {
    return {
        ...(form.expectedBy && { expectedBy: form.expectedBy }),
        ...(form.ignoreBefore && { ignoreBefore: form.ignoreBefore }),
    };
}
