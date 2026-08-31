import type { StoredItem } from '../types/MyDB';

/**
 * The statuses that participate in the tickler. This set is mirrored in three places that must
 * never drift: the pages that HIDE snoozed items (/next-actions, /waiting-for, /someday), the
 * /tickler page that SHOWS them, and the Weekly Review's tickler/list stages — share this
 * constant rather than re-listing statuses.
 */
export const TICKLER_STATUSES = ['nextAction', 'waitingFor', 'somedayMaybe'] as const;

/** True when the item's status is one the tickler pattern applies to (calendar items are not). */
export function participatesInTickler(item: Pick<StoredItem, 'status'>): boolean {
    return (TICKLER_STATUSES as ReadonlyArray<string>).includes(item.status);
}

/**
 * The tickler predicate: true when the item is snoozed past `todayIso` (the user-local calendar
 * day — render paths must pass the `useTodayIso()` value so the boundary rolls at local midnight)
 * and must therefore be hidden from its active list. Applies to `nextAction`, `waitingFor`, and
 * `somedayMaybe` items; `calendar` items ignore `ignoreBefore` entirely and never consult this.
 * One shared predicate so every list judges the boundary identically (docs/DATA_MODEL.md
 * "Tickler pattern").
 */
export function isTicklerHidden(item: Pick<StoredItem, 'ignoreBefore'>, todayIso: string): boolean {
    return item.ignoreBefore !== undefined && item.ignoreBefore > todayIso;
}
