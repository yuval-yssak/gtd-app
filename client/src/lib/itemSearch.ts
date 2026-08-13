import type { StoredItem, StoredPerson, StoredWorkContext } from '../types/MyDB';

export type ItemSortKey = 'createdTs' | 'updatedTs';
export type ItemSortDir = 'asc' | 'desc';

export const ALL_STATUSES = [
    'inbox',
    'nextAction',
    'calendar',
    'waitingFor',
    'somedayMaybe',
    'done',
    'trash',
] as const satisfies readonly StoredItem['status'][];

export const ACTIVE_STATUSES: readonly StoredItem['status'][] = ['inbox', 'nextAction', 'calendar', 'waitingFor', 'somedayMaybe'];

export const STATUS_LABELS: Record<StoredItem['status'], string> = {
    inbox: 'Inbox',
    nextAction: 'Next Action',
    calendar: 'Calendar',
    waitingFor: 'Waiting For',
    somedayMaybe: 'Someday / Maybe',
    done: 'Done',
    trash: 'Trash',
};

export const STATUS_ORDER: Record<StoredItem['status'], number> = {
    inbox: 0,
    nextAction: 1,
    calendar: 2,
    waitingFor: 3,
    somedayMaybe: 4,
    done: 5,
    trash: 6,
};

export type SearchDateField = 'createdTs' | 'updatedTs';

export interface SearchFilters {
    query: string;
    statuses: ReadonlySet<StoredItem['status']>;
    personId: string | null;
    contextId: string | null;
    /** Same-name twin group `personId` expands to in the merged multi-account view; when present
     *  it supersedes the single-id match so items tagged with either account's twin stay matched. */
    personIds?: ReadonlySet<string>;
    /** Same as `personIds`, for `contextId`. */
    contextIds?: ReadonlySet<string>;
    dateField: SearchDateField;
    dateFrom: string | null; // ISO date YYYY-MM-DD inclusive
    dateTo: string | null; // ISO date YYYY-MM-DD inclusive
}

export const DEFAULT_SEARCH_STATUSES: ReadonlySet<StoredItem['status']> = new Set(ACTIVE_STATUSES);

// Default filters used by the search page on first load and as a "no filter" comparison.
export const DEFAULT_SEARCH_FILTERS: SearchFilters = {
    query: '',
    statuses: DEFAULT_SEARCH_STATUSES,
    personId: null,
    contextId: null,
    dateField: 'updatedTs',
    dateFrom: null,
    dateTo: null,
};

/** All person ids an item references: `peopleIds` plus the waiting-for target. The single source
 *  of truth for "this item involves this person" — filters, usage ranking, and tag chips must all
 *  agree, or a chip can appear that matches nothing (and vice versa). */
export function itemPersonRefIds(item: StoredItem): string[] {
    return [...(item.peopleIds ?? []), ...(item.waitingForPersonId ? [item.waitingForPersonId] : [])];
}

const matchesPerson = (item: StoredItem, personId: string) => itemPersonRefIds(item).includes(personId);

const matchesContext = (item: StoredItem, contextId: string) => item.workContextIds?.includes(contextId) === true;

// dateFrom/dateTo are ISO dates (YYYY-MM-DD) — compared against the date prefix of the item's
// ISO datetime. Lexicographic comparison works because ISO 8601 is sort-friendly.
const matchesDateRange = (item: StoredItem, field: SearchDateField, from: string | null, to: string | null) => {
    if (!from && !to) return true;
    const ts = item[field];
    const datePart = ts.slice(0, 10);
    if (from && datePart < from) return false;
    if (to && datePart > to) return false;
    return true;
};

const matchesQuery = (item: StoredItem, normalizedQuery: string) => {
    if (!normalizedQuery) return true;
    if (item.title.toLowerCase().includes(normalizedQuery)) return true;
    if (item.notes?.toLowerCase().includes(normalizedQuery)) return true;
    return false;
};

export function filterItems(items: readonly StoredItem[], filters: SearchFilters): StoredItem[] {
    const normalizedQuery = filters.query.trim().toLowerCase();
    return items.filter((item) => {
        if (!filters.statuses.has(item.status)) return false;
        if (filters.personId) {
            const personIds = filters.personIds;
            const matched = personIds ? itemPersonRefIds(item).some((id) => personIds.has(id)) : matchesPerson(item, filters.personId);
            if (!matched) return false;
        }
        if (filters.contextId) {
            const contextIds = filters.contextIds;
            const matched = contextIds ? item.workContextIds?.some((id) => contextIds.has(id)) === true : matchesContext(item, filters.contextId);
            if (!matched) return false;
        }
        if (!matchesDateRange(item, filters.dateField, filters.dateFrom, filters.dateTo)) return false;
        if (!matchesQuery(item, normalizedQuery)) return false;
        return true;
    });
}

/**
 * Case-insensitive title/notes substring filter — the query semantics of the /search page,
 * reused by the in-page search fields on virtualized list pages. A blank query returns the
 * input array unchanged (stable identity, so memoized consumers skip work).
 */
export function filterItemsByQuery(items: readonly StoredItem[], query: string): readonly StoredItem[] {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
        return items;
    }
    return items.filter((item) => matchesQuery(item, normalizedQuery));
}

export function sortItems(items: readonly StoredItem[], key: ItemSortKey, dir: ItemSortDir): StoredItem[] {
    const sign = dir === 'asc' ? 1 : -1;
    // Plain string comparison — ISO 8601 timestamps sort lexicographically, and localeCompare
    // is ~20× slower, which matters when re-sorting thousands of archive rows per render.
    return [...items].sort((a, b) => (a[key] < b[key] ? -sign : a[key] > b[key] ? sign : 0));
}

export function groupByStatus(items: readonly StoredItem[]): Array<{ status: StoredItem['status']; items: StoredItem[] }> {
    const buckets = new Map<StoredItem['status'], StoredItem[]>();
    for (const item of items) {
        const bucket = buckets.get(item.status) ?? [];
        bucket.push(item);
        buckets.set(item.status, bucket);
    }
    return [...buckets.entries()].map(([status, items]) => ({ status, items })).sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
}

// Returns names of all people referenced by the item — used by the "people names" filter
// and (in future) for surfacing related contacts in result rows.
export function itemPersonNames(item: StoredItem, peopleById: Map<string, StoredPerson>): string[] {
    return itemPersonRefIds(item).flatMap((id) => {
        const p = peopleById.get(id);
        return p ? [p.name] : [];
    });
}

export function itemContextNames(item: StoredItem, contextsById: Map<string, StoredWorkContext>): string[] {
    return (item.workContextIds ?? []).flatMap((id) => {
        const c = contextsById.get(id);
        return c ? [c.name] : [];
    });
}

// {id, name} variants for UI that renders one element per tag — id gives a stable React key
// since display names are not unique (two people can share a name).
export interface ResolvedTag {
    id: string;
    name: string;
    /** The referenced entity is archived — rows render the chip dimmed. */
    archived?: boolean;
}

export function itemContextTags(item: StoredItem, contextsById: Map<string, StoredWorkContext>): ResolvedTag[] {
    return (item.workContextIds ?? []).flatMap((id) => {
        const c = contextsById.get(id);
        return c ? [{ id: c._id, name: c.name, ...(c.archived ? { archived: true } : {}) }] : [];
    });
}

export function itemPersonTags(item: StoredItem, peopleById: Map<string, StoredPerson>): ResolvedTag[] {
    return itemPersonRefIds(item).flatMap((id) => {
        const p = peopleById.get(id);
        return p ? [{ id: p._id, name: p.name, ...(p.archived ? { archived: true } : {}) }] : [];
    });
}
