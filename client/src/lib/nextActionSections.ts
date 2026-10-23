import dayjs from 'dayjs';
import type { StoredItem } from '../types/MyDB';
import { expectedDayKey } from './compareNextActions';

/** One expected-day group of the Next Actions list. `dayKey` is null for the trailing "No date". */
export interface NextActionSection<T> {
    dayKey: string | null;
    /** Stable DOM/React key: the day key, or `no-date`. */
    key: string;
    label: string;
    isOverdue: boolean;
    items: T[];
}

export const NO_DATE_SECTION_KEY = 'no-date';

/** Header text per section: "Overdue · Mon Oct 20", "Today", "Tomorrow", "Thu Oct 30", "No date". */
export function sectionLabel(dayKey: string | null, todayIso: string): string {
    if (dayKey === null) {
        return 'No date';
    }
    if (dayKey === todayIso) {
        return 'Today';
    }
    if (dayKey === dayjs(todayIso).add(1, 'day').format('YYYY-MM-DD')) {
        return 'Tomorrow';
    }
    const formatted = dayjs(dayKey).format('ddd MMM D');
    return dayKey < todayIso ? `Overdue · ${formatted}` : formatted;
}

/**
 * Splits an ALREADY SORTED (`compareNextActions`) list into contiguous sections, one per distinct
 * `expectedDayKey` plus "No date" last. Pure: the page passes `useTodayIso()` so headers roll at
 * local midnight. Drag and drop is constrained to one section (the date is never changed by a drag).
 */
export function groupIntoSections<T extends Pick<StoredItem, 'expectedBy'>>(sortedItems: readonly T[], todayIso: string): NextActionSection<T>[] {
    return sortedItems.reduce<NextActionSection<T>[]>((sections, item) => {
        const dayKey = expectedDayKey(item);
        const current = sections.at(-1);
        if (current && current.dayKey === dayKey) {
            current.items.push(item);
            return sections;
        }
        // Push, not spread: the accumulator is ours, and a spread per item is quadratic.
        sections.push({
            dayKey,
            key: dayKey ?? NO_DATE_SECTION_KEY,
            label: sectionLabel(dayKey, todayIso),
            isOverdue: dayKey !== null && dayKey < todayIso,
            items: [item],
        });
        return sections;
    }, []);
}

/** A virtualizer row: section headers are rows too, so they scroll with the list. */
export type FlatRow<T> = { kind: 'header'; section: NextActionSection<T> } | { kind: 'item'; section: NextActionSection<T>; item: T; isLastInSection: boolean };

export function flattenSections<T>(sections: ReadonlyArray<NextActionSection<T>>): FlatRow<T>[] {
    return sections.flatMap((section) => [
        { kind: 'header' as const, section },
        ...section.items.map((item, idx) => ({ kind: 'item' as const, section, item, isLastInSection: idx === section.items.length - 1 })),
    ]);
}

/** Virtualizer index of an item's row (headers count as rows), or -1 when the item is not rendered. */
export function flatIndexOfItem<T extends { _id: string }>(rows: readonly FlatRow<T>[], itemId: string): number {
    return rows.findIndex((row) => row.kind === 'item' && row.item._id === itemId);
}
