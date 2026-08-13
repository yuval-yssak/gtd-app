import type { StoredItem } from '../types/MyDB';
import { itemPersonRefIds } from './itemSearch';
import type { MergedFilterOption } from './mergedFilterOptions';
import { sortByName } from './sortByName';

/** Aggregated evidence that a work context / person is in active use. */
export interface EntityUsage {
    /** Number of referencing items (trash excluded — a trashed reference is not usage). */
    count: number;
    /** `updatedTs` of the most recently touched referencing item; '' when never referenced. */
    lastUsedTs: string;
}

/** Per-entity usage maps for both catalogue types, keyed by entity `_id`. */
export interface UsageIndex {
    contexts: ReadonlyMap<string, EntityUsage>;
    people: ReadonlyMap<string, EntityUsage>;
}

export const EMPTY_USAGE_INDEX: UsageIndex = { contexts: new Map(), people: new Map() };

function recordUse(map: Map<string, EntityUsage>, id: string, itemUpdatedTs: string) {
    const existing = map.get(id) ?? { count: 0, lastUsedTs: '' };
    map.set(id, { count: existing.count + 1, lastUsedTs: itemUpdatedTs > existing.lastUsedTs ? itemUpdatedTs : existing.lastUsedTs });
}

/**
 * One pass over the item set → usage maps for contexts and people. Trash is excluded (a trashed
 * reference is dead weight, not a signal); done items still count — completing tagged work is
 * exactly the evidence that a tag is alive.
 */
export function buildUsageIndex(items: readonly StoredItem[]): UsageIndex {
    const contexts = new Map<string, EntityUsage>();
    const people = new Map<string, EntityUsage>();
    for (const item of items) {
        if (item.status === 'trash') {
            continue;
        }
        for (const id of item.workContextIds ?? []) {
            recordUse(contexts, id, item.updatedTs);
        }
        for (const id of itemPersonRefIds(item)) {
            recordUse(people, id, item.updatedTs);
        }
    }
    return { contexts, people };
}

const NO_USAGE: EntityUsage = { count: 0, lastUsedTs: '' };

function compareUsage(a: EntityUsage, b: EntityUsage): number {
    if (a.count !== b.count) {
        return b.count - a.count;
    }
    return b.lastUsedTs.localeCompare(a.lastUsedTs);
}

/** Most-used first, most-recently-used breaks ties, then A→Z so the order is fully deterministic. */
export function rankByUsage<T extends { _id: string; name: string }>(entities: T[], usage: ReadonlyMap<string, EntityUsage>): T[] {
    return sortByName(entities).sort((a, b) => compareUsage(usage.get(a._id) ?? NO_USAGE, usage.get(b._id) ?? NO_USAGE));
}

/** Usage of a merged multi-account option = its twins' usage combined (sum counts, latest recency). */
function mergedOptionUsage(option: MergedFilterOption, usage: ReadonlyMap<string, EntityUsage>): EntityUsage {
    return option.ids.reduce((total, id) => {
        const twinUsage = usage.get(id) ?? NO_USAGE;
        return { count: total.count + twinUsage.count, lastUsedTs: twinUsage.lastUsedTs > total.lastUsedTs ? twinUsage.lastUsedTs : total.lastUsedTs };
    }, NO_USAGE);
}

/** rankByUsage for merged filter options: usage first, equal-usage options A→Z. The alphabetical
 *  pre-sort is applied here (not assumed of the caller) so the tie-break order is guaranteed. */
export function rankMergedOptionsByUsage(options: MergedFilterOption[], usage: ReadonlyMap<string, EntityUsage>): MergedFilterOption[] {
    return sortByName(options).sort((a, b) => compareUsage(mergedOptionUsage(a, usage), mergedOptionUsage(b, usage)));
}

/**
 * Drops archived entities from a picker/filter option pool — except ids in `keepIds` (currently
 * selected / already assigned), which must stay visible so they render and remain removable.
 */
export function omitArchived<T extends { _id: string; archived?: boolean }>(entities: T[], keepIds: ReadonlySet<string> = new Set()): T[] {
    return entities.filter((entity) => entity.archived !== true || keepIds.has(entity._id));
}
