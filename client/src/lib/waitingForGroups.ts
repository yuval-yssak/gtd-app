import type { StoredItem } from '../types/MyDB';

export const UNASSIGNED_GROUP_KEY = '__none__';

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

/** Orders group entries A→Z by resolved person name; "Unassigned" always sorts last. */
export function sortGroupEntriesByPersonName(groups: Record<string, StoredItem[]>, personMap: Record<string, string>): Array<[string, StoredItem[]]> {
    return Object.entries(groups).sort(([aId], [bId]) => {
        if (aId === UNASSIGNED_GROUP_KEY) return bId === UNASSIGNED_GROUP_KEY ? 0 : 1;
        if (bId === UNASSIGNED_GROUP_KEY) return -1;
        return resolvePersonName(personMap, aId).localeCompare(resolvePersonName(personMap, bId), undefined, { sensitivity: 'base' });
    });
}
