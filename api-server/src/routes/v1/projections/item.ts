import type { ItemInterface } from '../../../types/entities.js';

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
>;

const PUBLIC_FIELDS: ReadonlyArray<keyof PublicItem> = [
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

export function presentItem(item: ItemInterface): PublicItem {
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
    return out as PublicItem;
}
