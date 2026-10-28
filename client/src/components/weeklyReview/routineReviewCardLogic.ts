/**
 * Pure helpers behind RoutineReviewCard. Render-free so they unit-test under vitest's
 * `environment: 'node'` (the project has no jsdom — see vitest.config.ts).
 */
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
 * The series tail in the routine banner, e.g. "41 more after this one"; empty when the shown
 * occurrence is the last. Counted by id, not `length - 1`: an edit can turn the shown occurrence
 * into an exception, which drops it from `occurrences` while the card still shows it.
 */
export function remainingOccurrencesLabel(occurrences: ReadonlyArray<StoredItem>, shown: StoredItem | undefined): string {
    const others = occurrences.filter((occurrence) => occurrence._id !== shown?._id).length;
    return others > 0 ? `${others} more after this one` : '';
}
