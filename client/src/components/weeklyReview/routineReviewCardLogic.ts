/**
 * Pure helpers behind RoutineReviewCard. Render-free so they unit-test under vitest's
 * `environment: 'node'` (the project has no jsdom — see vitest.config.ts).
 */
import dayjs, { type Dayjs } from 'dayjs';
import type { OccurrenceDisposalPlan } from '../../db/itemMutations';
import { formatDisplayDate } from '../../lib/displayDate';
import { isOverdueCalendarItem } from '../../lib/routineNextItem';
import type { StoredItem, StoredRoutine } from '../../types/MyDB';
import { isModifiedExceptionItem } from './reviewFlowState';

/** The occurrences this card stands for: the routine's calendar items minus modified exceptions (those review on their own). */
export function collapsedOccurrences(routine: StoredRoutine, allItems: ReadonlyArray<StoredItem>): StoredItem[] {
    return allItems
        .filter((item) => item.routineId === routine._id && item.status === 'calendar' && !isModifiedExceptionItem(routine, item))
        .sort((a, b) => (a.timeStart ?? '').localeCompare(b.timeStart ?? ''));
}

/**
 * The occurrence whose date the calendar stage SORTED this entry by: the first still-open one.
 * `compareCalendarItems` ranks a routine entry by its earliest occurrence, so leading the card
 * with any other date would contradict the position the entry holds in the walk.
 */
export function sortAnchorOccurrence(occurrences: ReadonlyArray<StoredItem>): StoredItem | undefined {
    return occurrences.find((occurrence) => occurrence.timeStart !== undefined) ?? occurrences[0];
}

/**
 * The occurrence the card's embedded editor shows and its Done completes: the FIRST undone one,
 * overdue included — the same row the card was sorted by, so what the user sees is what they act
 * on. `pinnedId` is the occurrence the card opened on: an edit can turn it into a modified
 * exception (dropping it from `collapsedOccurrences`), and the editor must not jump to the next
 * occurrence under the user's hands. A pinned row that is no longer an open occurrence of this
 * routine (completed, trashed) yields to the first undone one.
 */
export function reviewedOccurrence(routine: StoredRoutine, allItems: ReadonlyArray<StoredItem>, pinnedId: string | undefined): StoredItem | undefined {
    const pinned = allItems.find((item) => item._id === pinnedId && item.routineId === routine._id && item.status === 'calendar');
    return pinned ?? sortAnchorOccurrence(collapsedOccurrences(routine, allItems));
}

/**
 * The occurrence a revisited routine decision reopens the editor on: the one it was decided over
 * (`occurrenceId`), whatever its status now — a Done decision shows the completed row. Decisions
 * that recorded none (older drafts) fall back to the live card's choice, the first undone one.
 */
export function revisitedOccurrence(routine: StoredRoutine, allItems: ReadonlyArray<StoredItem>, occurrenceId: string | undefined): StoredItem | undefined {
    const recorded = allItems.find((item) => item._id === occurrenceId && item.routineId === routine._id);
    return recorded ?? reviewedOccurrence(routine, allItems, undefined);
}

/** The occurrences whose end has already passed — still open, so the user never closed them out. */
export function overdueOccurrences(occurrences: ReadonlyArray<StoredItem>, now: Dayjs): StoredItem[] {
    return occurrences.filter((occurrence) => isOverdueCalendarItem(occurrence, now));
}

/**
 * The series tail in the routine banner: "41 more after this one", or — while other overdue
 * occurrences are still open — "2 more overdue · 40 upcoming", so the backlog behind the shown one
 * is never hidden in a single count. Empty when the shown occurrence is the last. Counted by id,
 * not `length - 1`: an edit can turn the shown occurrence into an exception, which drops it from
 * `occurrences` while the card still shows it.
 */
export function remainingOccurrencesLabel(occurrences: ReadonlyArray<StoredItem>, shown: StoredItem | undefined, now: Dayjs): string {
    const others = occurrences.filter((occurrence) => occurrence._id !== shown?._id);
    const overdueCount = overdueOccurrences(others, now).length;
    if (overdueCount === 0) {
        return others.length > 0 ? `${others.length} more after this one` : '';
    }
    const upcomingCount = others.length - overdueCount;
    return upcomingCount > 0 ? `${overdueCount} more overdue · ${upcomingCount} upcoming` : `${overdueCount} more overdue`;
}

/** Done on an overdue occurrence asks what happened to the others — whether they were done too, or missed. */
export function needsOverdueChoice(occurrences: ReadonlyArray<StoredItem>, shown: StoredItem, now: Dayjs): boolean {
    return isOverdueCalendarItem(shown, now) && overdueOccurrences(occurrences, now).some((occurrence) => occurrence._id !== shown._id);
}

/**
 * The overdue occurrence the card moves on to after disposing of `disposedIds`. Read from the
 * pre-disposal list (the app data refresh lands after the card decides), so the disposed rows
 * are excluded by id. Undefined when the backlog is cleared — the entry is then decided.
 */
export function nextOverdueOccurrence(occurrences: ReadonlyArray<StoredItem>, disposedIds: ReadonlySet<string>, now: Dayjs): StoredItem | undefined {
    return overdueOccurrences(occurrences, now).find((occurrence) => !disposedIds.has(occurrence._id));
}

/** The question the overdue chooser is asking, by id: the rows themselves are re-read when the user answers. */
export interface OverdueQuestion {
    shownId: string;
    overdueIds: ReadonlyArray<string>;
}

/**
 * The live rows an answer applies to. The chooser stays open across syncs, so writing the rows it
 * opened on would overwrite a remote edit under last-write-wins, or revive one completed elsewhere.
 * Rows that left the backlog meanwhile (completed, trashed, turned into an exception) drop out;
 * undefined when the occurrence Done was pressed on is gone — nothing is written then.
 */
export function resolveOverdueChoice(
    occurrences: ReadonlyArray<StoredItem>,
    question: OverdueQuestion,
    now: Dayjs,
): { shown: StoredItem; overdue: StoredItem[] } | undefined {
    const overdue = overdueOccurrences(occurrences, now).filter((occurrence) => question.overdueIds.includes(occurrence._id));
    const shown = overdue.find((occurrence) => occurrence._id === question.shownId);
    return shown ? { shown, overdue } : undefined;
}

/** What the user said about the overdue occurrences when completing one of them. */
export type OverdueChoice = 'allDone' | 'thisOneDone' | 'thisDoneRestMissed';

/** Turns the user's answer into the occurrences to complete and the ones to mark missed. `overdue` includes `shown`. */
export function planOverdueDisposal(choice: OverdueChoice, shown: StoredItem, overdue: ReadonlyArray<StoredItem>): OccurrenceDisposalPlan {
    const others = overdue.filter((occurrence) => occurrence._id !== shown._id);
    switch (choice) {
        case 'allDone':
            return { done: overdue, missed: [] };
        case 'thisOneDone':
            return { done: [shown], missed: [] };
        case 'thisDoneRestMissed':
            return { done: [shown], missed: others };
    }
}

// Past a handful of dates the list stops informing and starts crowding the dialog.
const LISTED_OVERDUE_DATES = 3;

/** "Tue, Aug 18 09:00 and Wed, Aug 19 09:00" — the overdue dates the chooser names, a long backlog capped with a count. */
export function overdueDatesLabel(overdue: ReadonlyArray<StoredItem>, now: Dayjs): string {
    const dates = overdue.map((occurrence) => occurrenceDateLabel(occurrence, now));
    if (dates.length > LISTED_OVERDUE_DATES + 1) {
        return `${dates.slice(0, LISTED_OVERDUE_DATES).join(', ')} and ${dates.length - LISTED_OVERDUE_DATES} more`;
    }
    const leading = dates.slice(0, -1);
    const last = dates.at(-1) ?? '';
    return leading.length > 0 ? `${leading.join(', ')} and ${last}` : last;
}

function occurrenceDateLabel(occurrence: StoredItem, now: Dayjs): string {
    const start = dayjs(occurrence.timeStart);
    const day = formatDisplayDate(start, 'ddd, MMM D', now);
    return occurrence.allDay ? day : `${day} ${start.format('HH:mm')}`;
}
