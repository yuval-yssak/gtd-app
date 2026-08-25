import type { StoredItem } from '../types/MyDB';

// Four-tier sort: focused-with-date (expectedBy asc), focused-no-date, other-with-date
// (expectedBy asc), other-no-date. Focus is the primary partition, presence of an
// expectedBy is the secondary partition within each focus group. Shared by the Next Actions
// page and the weekly-review wizard so both walk items in the same order.
export function compareNextActions(a: StoredItem, b: StoredItem): number {
    const aFocus = a.focus === true;
    const bFocus = b.focus === true;
    if (aFocus !== bFocus) {
        return aFocus ? -1 : 1;
    }
    const aHasDate = Boolean(a.expectedBy);
    const bHasDate = Boolean(b.expectedBy);
    if (aHasDate !== bHasDate) {
        return aHasDate ? -1 : 1;
    }
    if (!aHasDate) {
        return 0;
    }
    return (a.expectedBy ?? '').localeCompare(b.expectedBy ?? '');
}
