import type { StoredItem, StoredPerson } from '../types/MyDB';

export const UNASSIGNED_GROUP_KEY = '__none__';

/**
 * Person id → display name for group headers and ordering. Pass the UNFILTERED people list
 * (`allPeople`): a visible item can wait on a hidden account's person, and its name must still
 * resolve instead of falling back to "Unknown".
 */
export function personNameMap(people: ReadonlyArray<StoredPerson>): Record<string, string> {
    return Object.fromEntries(people.map((person) => [person._id, person.name]));
}

/** Groups waitingFor items by `waitingForPersonId`, falling back to the "Unassigned" bucket. */
export function groupByWaitingForPerson(items: StoredItem[]): Record<string, StoredItem[]> {
    return items.reduce<Record<string, StoredItem[]>>((acc, item) => {
        const key = item.waitingForPersonId ?? UNASSIGNED_GROUP_KEY;
        acc[key] = [...(acc[key] ?? []), item];
        return acc;
    }, {});
}

/** Resolves a person's display name, falling back to "Unknown" for ids missing from the map. */
export function resolvePersonName(personMap: Record<string, string>, personId: string) {
    return personMap[personId] ?? 'Unknown';
}

/**
 * Flattens items into the /waiting-for page's DEFAULT (person-grouped) presentation order:
 * groups A→Z by resolved name with "Unassigned" last, each group keeping the input item order.
 */
export function flattenByPersonGroups(items: StoredItem[], personMap: Record<string, string>): StoredItem[] {
    return sortGroupEntriesByPersonName(groupByWaitingForPerson(items), personMap).flatMap(([, groupItems]) => groupItems);
}

/** Orders group entries A→Z by resolved person name; "Unassigned" always sorts last. */
export function sortGroupEntriesByPersonName(groups: Record<string, StoredItem[]>, personMap: Record<string, string>): Array<[string, StoredItem[]]> {
    return Object.entries(groups).sort(([aId], [bId]) => {
        if (aId === UNASSIGNED_GROUP_KEY) return bId === UNASSIGNED_GROUP_KEY ? 0 : 1;
        if (bId === UNASSIGNED_GROUP_KEY) return -1;
        return resolvePersonName(personMap, aId).localeCompare(resolvePersonName(personMap, bId), undefined, { sensitivity: 'base' });
    });
}
