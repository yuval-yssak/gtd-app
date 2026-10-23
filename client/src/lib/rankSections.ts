import type { StoredItem } from '../types/MyDB';
import { expectedDayKey } from './compareNextActions';

/**
 * Which item lists carry a manual order, and what one "section" of that order is — the unit a
 * drag stays inside and the reorder engine re-keys within. A section is the status plus, for the
 * dated lists, the expected day (a drag never changes a date). The Calendar has no manual order:
 * it is purely chronological.
 */
const DAY_KEYED_STATUSES: ReadonlySet<StoredItem['status']> = new Set(['nextAction', 'waitingFor']);
const FLAT_STATUSES: ReadonlySet<StoredItem['status']> = new Set(['inbox', 'somedayMaybe']);

/** Every account owning rows of `status` in the merged list, visible or not: they share the keyspace a re-key must see. */
export function ownerIdsOfStatus(items: readonly StoredItem[], status: StoredItem['status']): string[] {
    return [...new Set(items.filter((item) => item.status === status).map((item) => item.userId))];
}

/** The section an item is ordered within, or null for a status with no manual order (calendar, done, trash). */
export function rankSectionKeyOf(item: Pick<StoredItem, 'status' | 'expectedBy'>): string | null {
    if (DAY_KEYED_STATUSES.has(item.status)) {
        return `${item.status}:${expectedDayKey(item) ?? 'undated'}`;
    }
    return FLAT_STATUSES.has(item.status) ? item.status : null;
}
