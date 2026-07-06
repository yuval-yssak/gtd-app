import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import type { ItemInterface, RoutineInterface } from '../types/entities.js';
import { computeNextOccurrence } from './rruleHelpers.js';

dayjs.extend(utc);

// MIRROR: client/src/lib/routineOpenItemMerge.ts — keep the stamping rules, merge semantics,
// and first-occurrence anchor logic in sync. Both sides run the same test-vector matrix
// (src/tests/routineOpenItemMerge.test.ts on each side).

/**
 * Item fields whose values the nextAction generator stamps from the routine template and which the
 * open-item merge may therefore adopt. `title` is handled separately — it is required on the item,
 * so it can be overwritten but never deleted.
 */
const OPTIONAL_STAMPED_KEYS = ['notes', 'workContextIds', 'peopleIds', 'energy', 'time', 'focus', 'urgent'] as const;
type OptionalStampedKey = (typeof OPTIONAL_STAMPED_KEYS)[number];

/** The generator-stamped slice of an open item: what `buildRoutineItemSnapshot` writes from the routine. */
export type StampedItemContent = Pick<ItemInterface, 'title' | OptionalStampedKey>;

/**
 * The exact content `buildRoutineItemSnapshot` (server) / `persistRoutineItem` (client) would stamp
 * onto a generated item for this routine. Presence rules mirror those generators key-for-key:
 * truthy checks for workContextIds/peopleIds/energy/notes, `!== undefined` for time/focus/urgent —
 * so the merge's "does the item still match what the old routine stamped?" comparison can never
 * drift from what the generator actually wrote.
 */
export function stampedItemContent(routine: Pick<RoutineInterface, 'title' | 'template'>): StampedItemContent {
    const { template } = routine;
    return {
        title: routine.title,
        ...(template.workContextIds ? { workContextIds: template.workContextIds } : {}),
        ...(template.peopleIds ? { peopleIds: template.peopleIds } : {}),
        ...(template.energy ? { energy: template.energy } : {}),
        ...(template.time !== undefined ? { time: template.time } : {}),
        ...(template.focus !== undefined ? { focus: template.focus } : {}),
        ...(template.urgent !== undefined ? { urgent: template.urgent } : {}),
        ...(template.notes ? { notes: template.notes } : {}),
    };
}

/** Element-wise equality for the two ID-array fields; strict equality for everything else. */
function stampedValuesEqual(a: unknown, b: unknown): boolean {
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((value, i) => value === b[i]);
    }
    return a === b;
}

/** Writes an adopted value onto the merged item, deleting the key when the new template omits it. */
function applyAdoptedValue<K extends OptionalStampedKey>(merged: Pick<ItemInterface, OptionalStampedKey>, key: K, value: StampedItemContent[K]): void {
    if (value === undefined) {
        delete merged[key];
        return;
    }
    merged[key] = value;
}

/** A routine edit as seen by the open-item merge: the pre-edit and post-edit routine states. */
export interface RoutineContentEdit {
    previous: Pick<RoutineInterface, 'title' | 'template'>;
    next: Pick<RoutineInterface, 'title' | 'template'>;
    now: string;
}

/**
 * Three-way merge of a routine edit into the routine's open nextAction item. Per stamped field:
 * the item's value is updated to the new template's stamp only when it still equals what the
 * PRE-EDIT routine stamped — a field the user hand-tweaked on the item differs from that baseline
 * and is preserved. Returns the updated item (with `updatedTs = edit.now`), or `null` when no
 * field changed so callers can skip the write + op entirely.
 */
export function mergeRoutineEditIntoOpenItem(item: ItemInterface, edit: RoutineContentEdit): ItemInterface | null {
    const oldStamp = stampedItemContent(edit.previous);
    const newStamp = stampedItemContent(edit.next);
    const merged: ItemInterface = { ...item };
    const adoptedTitle = item.title === oldStamp.title && oldStamp.title !== newStamp.title;
    if (adoptedTitle) {
        merged.title = newStamp.title;
    }
    const adoptedKeys = OPTIONAL_STAMPED_KEYS.filter((key) => {
        if (!stampedValuesEqual(item[key], oldStamp[key]) || stampedValuesEqual(oldStamp[key], newStamp[key])) {
            return false;
        }
        applyAdoptedValue(merged, key, newStamp[key]);
        return true;
    });
    if (!adoptedTitle && adoptedKeys.length === 0) {
        return null;
    }
    return { ...merged, updatedTs: edit.now };
}

/**
 * The `expectedBy` date (YYYY-MM-DD) the routine's FIRST occurrence lands on, anchored at
 * `max(localToday, startDate)` with `includeAnchor=true` — the exact semantics of
 * `ensureFirstRoutineItem` / `createFirstRoutineItem`, extracted so the schedule-recompute path
 * produces the same date the generator would. `localTodayStr` is the caller's local calendar date
 * (see the client's `createFirstRoutineItem` for the UTC-midnight-on-local-date reasoning);
 * passing it in keeps this pure and testable. Throws `RruleExhaustedError` when the rrule has no
 * occurrence left.
 */
export function computeFirstOccurrenceDate(routine: Pick<RoutineInterface, 'rrule' | 'startDate'>, localTodayStr: string): string {
    const todayAsUtcDay = dayjs.utc(localTodayStr).toDate();
    const startAsUtcDay = routine.startDate ? dayjs.utc(routine.startDate).toDate() : null;
    const anchor = startAsUtcDay && startAsUtcDay > todayAsUtcDay ? startAsUtcDay : todayAsUtcDay;
    return dayjs.utc(computeNextOccurrence(routine.rrule, anchor, true)).format('YYYY-MM-DD');
}
