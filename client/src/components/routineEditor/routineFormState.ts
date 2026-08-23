import dayjs from 'dayjs';
import type { CalendarOption } from '../../hooks/useCalendarOptions';
import { stripEndClauses } from '../../lib/routineSplitUtils';
import { deriveRecurrenceAnchor } from '../../lib/rruleUtils';
import { hasAtLeastOne } from '../../lib/typeUtils';
import type { EnergyLevel, StoredRoutine } from '../../types/MyDB';

/**
 * Pure form-state model for the routine editor. Extracted from RoutineEditorBody so surfaces that
 * embed the routine form without the full editor shell (the clarify-to-routine destination in the
 * item editor) can share the exact same state shape and save-payload builders.
 */

export type EndsMode = 'never' | 'onDate' | 'afterN';

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
export function buildFinalRrule(baseRrule: string, endsMode: EndsMode, endsDate: string, endsCount: string): string {
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
export function resolveCalendarLink(configId: string, options: CalendarOption[]): { calendarSyncConfigId?: string; calendarIntegrationId?: string } {
    if (configId) {
        const selected = options.find((o) => o.configId === configId);
        return selected ? { calendarSyncConfigId: selected.configId, calendarIntegrationId: selected.integrationId } : {};
    }
    const fallback = options.find((o) => o.isDefault) ?? (hasAtLeastOne(options) ? options[0] : undefined);
    return fallback ? { calendarIntegrationId: fallback.integrationId } : {};
}

export function buildTemplate(form: FormState) {
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

/** True when the routine form is missing a field its Save/Create action requires (title excluded —
 *  hosts that own the title input gate on it separately). All-day calendar routines don't require
 *  a time-of-day; timed ones do. */
export function isRoutineFormIncomplete(form: FormState): boolean {
    if (!form.rrule) {
        return true;
    }
    return form.routineType === 'calendar' && !form.allDay && !form.timeOfDay;
}
