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
    | 'statusBeforeDone'
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
    | 'urgent'
    | 'rank'
    | 'routineId'
    | 'calendarEventId'
    | 'calendarIntegrationId'
    | 'calendarSyncConfigId'
    | 'location'
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
    // Read-only: the open status a done item was completed from (server-stamped; PATCH rejects it).
    'statusBeforeDone',
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
    'urgent',
    // Read-only priority order inside a Next Actions day section. PATCH rejects it as
    // forbidden_field; `/v1/operations/batch` round-trips it (a get→batch-update echo must keep it).
    'rank',
    'routineId',
    'calendarEventId',
    'calendarIntegrationId',
    'calendarSyncConfigId',
    // Read-only mirror of the Google event's location (GCal-owned; PATCH rejects it as
    // forbidden_field). Exposed so an agent can see whether a linked calendar item names its
    // venue — the MCP's field guidance inspects it — and set it on the Google event if not.
    'location',
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

/**
 * The `view=compact` list row: what an agent needs to scan and pick items — no notes, no brief and
 * no sync linkage, so a long list fits in a reader that truncates its tool output (voice mode).
 */
export type CompactItem = Pick<
    PublicItem,
    | '_id'
    | 'status'
    | 'title'
    | 'workContextIds'
    | 'peopleIds'
    | 'waitingForPersonId'
    | 'energy'
    | 'time'
    | 'urgent'
    | 'expectedBy'
    | 'ignoreBefore'
    | 'timeStart'
    | 'timeEnd'
>;

// Listed by hand in the done_list_items `view` description and docs/PUBLIC_API.md too — keep them in step.
const COMPACT_FIELDS: ReadonlyArray<keyof CompactItem> = [
    '_id',
    'status',
    'title',
    'workContextIds',
    'peopleIds',
    'waitingForPersonId',
    'energy',
    'time',
    'urgent',
    'expectedBy',
    'ignoreBefore',
    'timeStart',
    'timeEnd',
];

export function presentCompactItem(item: PublicItem): CompactItem {
    // fromEntries widens to Record<string, unknown>; every key comes from COMPACT_FIELDS, so the cast is sound.
    return Object.fromEntries(COMPACT_FIELDS.flatMap((key) => (item[key] !== undefined ? [[key, item[key]]] : []))) as CompactItem;
}
