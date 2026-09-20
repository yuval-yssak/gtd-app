import { type BriefState, briefState } from '../../../lib/briefSource.js';
import type { BriefOrigin, ItemBriefInterface, ItemInterface } from '../../../types/entities.js';

/**
 * Allowlist projection for API responses. We use an allowlist (not an omit) so that a future
 * internal sync-anchor field added to ItemInterface (e.g. another lastSyncedXxxTs) does not
 * silently leak into the public schema and become a de-facto API contract. The fields below
 * mirror the documented v1 schema in PUBLIC_API.md.
 */
export type PublicItem = Pick<
    ItemInterface,
    | '_id'
    | 'user'
    | 'status'
    | 'title'
    | 'notes'
    | 'createdTs'
    | 'updatedTs'
    | 'externalId'
    | 'workContextIds'
    | 'peopleIds'
    | 'waitingForPersonId'
    | 'expectedBy'
    | 'ignoreBefore'
    | 'timeStart'
    | 'timeEnd'
    | 'energy'
    | 'time'
    | 'focus'
    | 'urgent'
    | 'routineId'
    | 'calendarEventId'
    | 'calendarIntegrationId'
    | 'calendarSyncConfigId'
> & { brief: PublicItemBrief | null };

/**
 * Read-only view of the item's brief sidecar. `state` is derived against the item's CURRENT
 * title + notes (see `briefState`), so a caller never has to recompute the source hash.
 * `sourceHash`, `user`, `itemId` and the LWW timestamps stay internal.
 */
export interface PublicItemBrief {
    text: string | null;
    origin: BriefOrigin;
    state: BriefState;
    generatedTs: string;
}

const PUBLIC_FIELDS: ReadonlyArray<Exclude<keyof PublicItem, 'brief'>> = [
    '_id',
    'user',
    'status',
    'title',
    'notes',
    'createdTs',
    'updatedTs',
    'externalId',
    'workContextIds',
    'peopleIds',
    'waitingForPersonId',
    'expectedBy',
    'ignoreBefore',
    'timeStart',
    'timeEnd',
    'energy',
    'time',
    'focus',
    'urgent',
    'routineId',
    'calendarEventId',
    'calendarIntegrationId',
    'calendarSyncConfigId',
];

export function presentBrief(item: ItemInterface, brief: ItemBriefInterface | null): PublicItemBrief | null {
    if (!brief) {
        return null;
    }
    return { text: brief.text, origin: brief.origin, state: briefState(item, brief), generatedTs: brief.generatedTs };
}

/** `brief` is always present (null when the item has no sidecar row) so callers can rely on the key. */
export function presentItem(item: ItemInterface, brief: ItemBriefInterface | null): PublicItem {
    const out: Partial<PublicItem> = {};
    for (const key of PUBLIC_FIELDS) {
        const value = item[key];
        if (value !== undefined) {
            // Per-key copy through `as never` is the only way to satisfy a heterogeneous Pick
            // assignment loop without per-field branching — value's type is already narrowed
            // by the source ItemInterface key.
            (out as Record<string, unknown>)[key] = value;
        }
    }
    out.brief = presentBrief(item, brief);
    return out as PublicItem;
}
