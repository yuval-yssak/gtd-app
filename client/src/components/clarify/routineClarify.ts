import type { ClarifiedRoutineFields } from '../../db/routineClarifyMutations';
import type { CalendarOption } from '../../hooks/useCalendarOptions';
import type { StoredItem } from '../../types/MyDB';
import {
    buildFinalRrule,
    buildRoutineTemplateFromForm,
    buildTemplate,
    type FormState,
    initFormState,
    isRoutineFormIncomplete,
    resolveCalendarLink,
} from '../routineEditor/routineFormState';

/**
 * Pure builders for the item editor's clarify-to-routine destination. The routine form is the
 * routine editor's own FormState; title/notes stay on the item editor's fields and flow in via the
 * (already-normalized) item snapshot at save time.
 */

/**
 * The Routine chip is strictly part of initial clarification — it only appears on plain inbox
 * captures. A routine-generated item that was moved back to inbox still belongs to its series;
 * converting it would trash it and thereby advance the OLD routine, with undo unavailable
 * (see offerClarifyToRoutineUndo) — so it is never offered the destination.
 */
export function canClarifyToRoutine(item: Pick<StoredItem, 'status' | 'routineId'>): boolean {
    return item.status === 'inbox' && !item.routineId;
}

/** Seeds the routine form from the item: defaults everywhere, plus any nextAction metadata the
 *  item already carries (energy, time, contexts, people) pre-filling the routine's template. */
export function itemToRoutineForm(item: StoredItem): FormState {
    return {
        ...initFormState(),
        workContextIds: item.workContextIds ?? [],
        peopleIds: item.peopleIds ?? [],
        energy: item.energy ?? '',
        time: item.time?.toString() ?? '',
        focus: item.focus ?? false,
        urgent: item.urgent ?? false,
    };
}

/** Maps the normalized item + routine form into the clarifyToRoutine payload. */
export function buildRoutineFieldsFromClarify(item: StoredItem, form: FormState, calendarOptions: CalendarOption[]): ClarifiedRoutineFields {
    const calendarItemTemplate = buildRoutineTemplateFromForm(form);
    const calendarLink = form.routineType === 'calendar' ? resolveCalendarLink(form.calendarSyncConfigId, calendarOptions) : {};
    return {
        title: item.title,
        routineType: form.routineType,
        rrule: buildFinalRrule(form.rrule, form.endsMode, form.endsDate, form.endsCount),
        // The item's notes become the routine's template notes (copied onto every generated item).
        // form.notes is force-blanked: the clarify flow renders no routine notes input, and this
        // keeps a future notes field in RoutineScheduleFields from silently leaking in here.
        template: { ...buildTemplate({ ...form, notes: '' }), ...(item.notes ? { notes: item.notes } : {}) },
        ...(calendarItemTemplate !== undefined ? { calendarItemTemplate } : {}),
        ...calendarLink,
        ...(form.startDate ? { startDate: form.startDate } : {}),
        // recurrenceAnchor is only meaningful for nextAction routines (see StoredRoutine).
        ...(form.routineType === 'nextAction' ? { recurrenceAnchor: form.recurrenceAnchor } : {}),
    };
}

/** Save gate for the routine destination — mirrors the routine editor's own required fields. */
export function isClarifyToRoutineSaveDisabled(title: string, form: FormState): boolean {
    return !title.trim() || isRoutineFormIncomplete(form);
}
