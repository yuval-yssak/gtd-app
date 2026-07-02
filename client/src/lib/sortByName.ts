interface Named {
    name: string;
}

/**
 * New array sorted A→Z by `name`, locale-aware and case-insensitive. Pure — the input array is
 * untouched. Applied at consumer sites (filter bars, chip pickers, dropdowns) rather than in
 * AppDataProvider so pages that rely on the stored order keep it.
 */
export function sortByName<T extends Named>(entities: T[]): T[] {
    return [...entities].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}
