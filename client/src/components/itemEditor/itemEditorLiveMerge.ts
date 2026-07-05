import dayjs from 'dayjs';
import type { StoredItem } from '../../types/MyDB';
import { type CalendarFormState, emptyCalendar, type NextActionFormState, type SomedayMaybeFormState, type WaitingForFormState } from '../clarify/types';
import type { EditableStatus } from '../editItemDialogLogic';

/**
 * Live-merge support for the item editor: while the editor is open, sync can update the item
 * underneath it (another device, a GCal webhook, our own committed autosave echoing back).
 *
 * Policy (see lib/liveMerge for the two-field prototype):
 * - a form field that still equals its seed (the value it was last seeded/merged from) is CLEAN
 *   and silently adopts the incoming value;
 * - a DIRTY field keeps the local edit; when the incoming version also changed that field to a
 *   different value, the field is reported as a conflict so the editor can show the
 *   "changed on another device" notice with a "Use their version" escape hatch.
 */

/** Everything the editor seeds from the item, bundled so merge logic can treat it uniformly. */
export interface ItemFormSeeds {
    title: string;
    notes: string;
    status: EditableStatus;
    na: NextActionFormState;
    cal: CalendarFormState;
    wf: WaitingForFormState;
    sm: SomedayMaybeFormState;
}

// The all-day decode path (inclusive endDate from the +1-day exclusive stored value) is the form's
// only round-trip dependency on the all-day encoding. Lives here (not ItemEditorBody) so the merge
// module never imports the component — that would be a cycle.
export function itemToCalendarForm(item: StoredItem): CalendarFormState {
    if (!item.timeStart) {
        return emptyCalendar;
    }
    // All-day items store YYYY-MM-DD strings on timeStart/timeEnd (GCal exclusive-end preserved).
    // Decode the +1-day shift back to an inclusive endDate so the picker shows the date the user
    // would think of as "the last day"; a single-day event renders with endDate === '' (blank).
    if (item.allDay) {
        const startDate = item.timeStart;
        const inclusiveEnd = item.timeEnd ? dayjs(item.timeEnd).subtract(1, 'day').format('YYYY-MM-DD') : startDate;
        return {
            date: startDate,
            startTime: '',
            endTime: '',
            calendarSyncConfigId: item.calendarSyncConfigId ?? '',
            allDay: true,
            endDate: inclusiveEnd === startDate ? '' : inclusiveEnd,
        };
    }
    const start = dayjs(item.timeStart);
    const end = item.timeEnd ? dayjs(item.timeEnd) : start.add(1, 'hour');
    return {
        date: start.format('YYYY-MM-DD'),
        startTime: start.format('HH:mm'),
        endTime: end.format('HH:mm'),
        calendarSyncConfigId: item.calendarSyncConfigId ?? '',
        allDay: false,
        endDate: '',
    };
}

export function itemToNextActionForm(item: StoredItem): NextActionFormState {
    return {
        ignoreBefore: item.ignoreBefore ?? '',
        workContextIds: item.workContextIds ?? [],
        peopleIds: item.peopleIds ?? [],
        energy: item.energy ?? '',
        time: item.time?.toString() ?? '',
        urgent: item.urgent ?? false,
        focus: item.focus ?? false,
        expectedBy: item.expectedBy ?? '',
    };
}

export function itemToWaitingForForm(item: StoredItem): WaitingForFormState {
    return {
        waitingForPersonId: item.waitingForPersonId ?? '',
        expectedBy: item.expectedBy ?? '',
        // WaitingFor no longer exposes an `Ignore before` input — seed it empty so editing a waiting
        // item never re-persists a hidden tickler date the user can't see.
        ignoreBefore: '',
    };
}

export function itemToSomedayMaybeForm(item: StoredItem): SomedayMaybeFormState {
    return {
        expectedBy: item.expectedBy ?? '',
        ignoreBefore: item.ignoreBefore ?? '',
    };
}

export function itemToFormSeeds(item: StoredItem): ItemFormSeeds {
    return {
        title: item.title,
        notes: item.notes ?? '',
        status: item.status,
        na: itemToNextActionForm(item),
        cal: itemToCalendarForm(item),
        wf: itemToWaitingForForm(item),
        sm: itemToSomedayMaybeForm(item),
    };
}

/** Human-readable labels for the conflict notice, per form-group field. */
const NA_LABELS: Record<keyof NextActionFormState, string> = {
    ignoreBefore: 'Ignore before',
    workContextIds: 'Contexts',
    peopleIds: 'People',
    energy: 'Energy',
    time: 'Time estimate',
    urgent: 'Urgent',
    focus: 'Focus',
    expectedBy: 'Expected by',
};
const CAL_LABELS: Record<keyof CalendarFormState, string> = {
    date: 'Date',
    startTime: 'Start time',
    endTime: 'End time',
    calendarSyncConfigId: 'Calendar',
    allDay: 'All-day',
    endDate: 'End date',
};
const WF_LABELS: Record<keyof WaitingForFormState, string> = {
    waitingForPersonId: 'Waiting on',
    expectedBy: 'Expected by',
    ignoreBefore: 'Ignore before',
};
const SM_LABELS: Record<keyof SomedayMaybeFormState, string> = {
    expectedBy: 'Expected by',
    ignoreBefore: 'Ignore before',
};

function valuesEqual(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Merges one form group. Clean keys (form === seed) adopt the incoming value; dirty keys keep the
 * form value and are reported as conflicts when the incoming version changed them differently.
 */
export function mergeFormGroup<T extends object>(form: T, seed: T, incoming: T, labels: Record<keyof T, string>): { merged: T; conflicts: string[] } {
    const merged = { ...form };
    const conflicts: string[] = [];
    for (const key of Object.keys(incoming) as Array<keyof T>) {
        if (valuesEqual(form[key], seed[key])) {
            merged[key] = incoming[key];
            continue;
        }
        if (!valuesEqual(incoming[key], seed[key]) && !valuesEqual(incoming[key], form[key])) {
            conflicts.push(labels[key]);
        }
    }
    return { merged, conflicts };
}

export interface ItemFormsMergeResult {
    merged: ItemFormSeeds;
    /** Labels of fields where both the user and the incoming version diverged — show the notice. */
    conflicts: string[];
}

/**
 * Full-editor merge: text + status + every per-status form group. `form` holds the editor's
 * current values, `seed` the values it last seeded/merged from, `incoming` the fresh item's seeds.
 */
export function mergeItemForms(form: ItemFormSeeds, seed: ItemFormSeeds, incoming: ItemFormSeeds): ItemFormsMergeResult {
    const text = mergeFormGroup(
        { title: form.title, notes: form.notes, status: form.status },
        { title: seed.title, notes: seed.notes, status: seed.status },
        { title: incoming.title, notes: incoming.notes, status: incoming.status },
        { title: 'Title', notes: 'Notes', status: 'Status' },
    );
    const na = mergeFormGroup(form.na, seed.na, incoming.na, NA_LABELS);
    const cal = mergeFormGroup(form.cal, seed.cal, incoming.cal, CAL_LABELS);
    const wf = mergeFormGroup(form.wf, seed.wf, incoming.wf, WF_LABELS);
    const sm = mergeFormGroup(form.sm, seed.sm, incoming.sm, SM_LABELS);

    // Only surface conflicts for the form group the current status renders — a "conflict" on a
    // hidden form (e.g. calendar times while the item is a nextAction) is noise the user can't act on.
    const activeGroupConflicts = groupConflictsForStatus(form.status, { na: na.conflicts, cal: cal.conflicts, wf: wf.conflicts, sm: sm.conflicts });

    return {
        merged: {
            title: text.merged.title,
            notes: text.merged.notes,
            status: text.merged.status,
            na: na.merged,
            cal: cal.merged,
            wf: wf.merged,
            sm: sm.merged,
        },
        conflicts: [...text.conflicts, ...activeGroupConflicts],
    };
}

/** Arguments for `hasUnsavedStructuralItemEdits`, bundled — they describe one editor snapshot. */
export interface ItemStructuralEditCheck {
    /** The editor's current form values. */
    form: ItemFormSeeds;
    /** The values the form was last seeded/merged from (= the persisted state). */
    seed: ItemFormSeeds;
    /** Wizard-preselected status chip — a status equal to it is a preset, not a user edit. */
    initialStatus?: EditableStatus | undefined;
    /** Meetings with attendees keep title/notes on explicit Save — count them as structural too. */
    includeText: boolean;
}

/**
 * True when the editor holds edits that only the explicit Save button would persist — the state
 * the unsaved-changes navigation guard protects. Autosaved text is excluded (navigation flushes
 * it), and only the form group the current status renders counts: hidden groups are dropped on
 * save, so losing them to navigation loses nothing Save would have kept.
 */
export function hasUnsavedStructuralItemEdits({ form, seed, initialStatus, includeText }: ItemStructuralEditCheck): boolean {
    if (form.status !== seed.status && form.status !== initialStatus) {
        return true;
    }
    if (includeText && (form.title !== seed.title || form.notes !== seed.notes)) {
        return true;
    }
    return isActiveGroupDirty(form, seed);
}

function isActiveGroupDirty(form: ItemFormSeeds, seed: ItemFormSeeds): boolean {
    if (form.status === 'nextAction') {
        return !valuesEqual(form.na, seed.na);
    }
    if (form.status === 'calendar') {
        return !valuesEqual(form.cal, seed.cal);
    }
    if (form.status === 'waitingFor') {
        return !valuesEqual(form.wf, seed.wf);
    }
    if (form.status === 'somedayMaybe') {
        return !valuesEqual(form.sm, seed.sm);
    }
    return false;
}

function groupConflictsForStatus(status: EditableStatus, groups: { na: string[]; cal: string[]; wf: string[]; sm: string[] }): string[] {
    if (status === 'nextAction') {
        return groups.na;
    }
    if (status === 'calendar') {
        return groups.cal;
    }
    if (status === 'waitingFor') {
        return groups.wf;
    }
    if (status === 'somedayMaybe') {
        return groups.sm;
    }
    return [];
}
