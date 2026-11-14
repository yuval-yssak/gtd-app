/**
 * When a COUNT-bounded nextAction routine has run out. Mirrored in
 * `client/src/lib/routineOccurrenceCount.ts` (parity fixture in both test suites).
 *
 * The generators re-anchor the rule's DTSTART at every completion, so the rule's own COUNT restarts
 * each time and never runs out — the series has to be ended by counting the occurrences already used.
 *
 * `trash` means both "the user skipped this occurrence" and "a gesture retired it" (pause, a
 * calendar → nextAction switch). Only a trashed row with a due date can be a skip, and a trashed date
 * being issued again (a resume after a pause) is not charged. Known cost: a rule that resumes on a
 * later date than the one paused (e.g. daily) loses that occurrence.
 * Conversely, skipping an occurrence before its due date hands the same date back uncharged — the
 * generator's pre-existing behavior, preferred over a skip ending the series early.
 */

/** The fields of a routine-generated item that decide whether it used up an occurrence. */
export interface RoutineOccurrence {
    _id?: string | undefined;
    status: string;
    expectedBy?: string | undefined;
}

const COUNT_CLAUSE = /(?:^|;)COUNT=(\d+)/i;

function rruleCount(rrule: string): number | null {
    const count = rrule.match(COUNT_CLAUSE)?.[1];
    return count === undefined ? null : Number.parseInt(count, 10);
}

/** A done occurrence always counts — calendar-phase history included, and also a date handed out
 *  again after an early completion (the re-anchored rule repeats it), or the series never ends. */
function doneKeys(routineItems: readonly RoutineOccurrence[]): (string | undefined)[] {
    return routineItems.filter((item) => item.status === 'done').map((item) => item.expectedBy ?? item._id);
}

/** Skipped nextAction occurrences: trashed rows with a due date, except the one being re-issued
 *  (a resume after a pause hands the trashed date out again). */
function skippedDates(routineItems: readonly RoutineOccurrence[], candidateDate: string): (string | undefined)[] {
    return routineItems
        .filter((item) => item.status === 'trash' && item.expectedBy !== undefined && item.expectedBy !== candidateDate)
        .map((item) => item.expectedBy);
}

/** One per due date, so twins count once. */
function countUsedOccurrences(routineItems: readonly RoutineOccurrence[], candidateDate: string): number {
    return new Set([...doneKeys(routineItems), ...skippedDates(routineItems, candidateDate)]).size;
}

/** True when the rule is COUNT-bounded and issuing an item due `candidateDate` would exceed it.
 *  `routineItems` must be this routine's items only. UNTIL-bounded rules end by date instead. */
export function hasUsedAllOccurrences(rrule: string, routineItems: readonly RoutineOccurrence[], candidateDate: string): boolean {
    const count = rruleCount(rrule);
    return count !== null && countUsedOccurrences(routineItems, candidateDate) >= count;
}
