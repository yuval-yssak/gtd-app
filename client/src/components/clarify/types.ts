import dayjs from 'dayjs';
import type { CalendarMeta } from '../../db/itemMutations';
import type { CalendarOption } from '../../hooks/useCalendarOptions';
import type { EnergyLevel } from '../../types/MyDB';

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
}

export const emptyCalendar: CalendarFormState = { date: '', startTime: '', endTime: '', calendarSyncConfigId: '' };

export interface WaitingForFormState {
    waitingForPersonId: string;
    expectedBy: string;
    ignoreBefore: string;
}

export const emptyWaitingFor: WaitingForFormState = { waitingForPersonId: '', expectedBy: '', ignoreBefore: '' };

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

/** Converts calendar form state into the meta object expected by clarifyToCalendar. */
export function buildCalendarMeta(form: CalendarFormState, calendarOptions: CalendarOption[]): CalendarMeta {
    const startIso = form.date ? dayjs(`${form.date}${form.startTime ? `T${form.startTime}` : ''}`).toISOString() : dayjs().toISOString();
    const endIso = form.date && form.endTime ? dayjs(`${form.date}T${form.endTime}`).toISOString() : dayjs(startIso).add(1, 'hour').toISOString();

    const selectedOption = calendarOptions.find((o) => o.configId === form.calendarSyncConfigId);
    return {
        timeStart: startIso,
        timeEnd: endIso,
        ...(selectedOption ? { calendarSyncConfigId: selectedOption.configId, calendarIntegrationId: selectedOption.integrationId } : {}),
    };
}

export function buildWaitingForMeta(form: WaitingForFormState) {
    return {
        waitingForPersonId: form.waitingForPersonId,
        ...(form.expectedBy && { expectedBy: form.expectedBy }),
        ...(form.ignoreBefore && { ignoreBefore: form.ignoreBefore }),
    };
}
