import type { StoredPerson } from '../types/MyDB';
import { sortByName } from './sortByName';

/** Lowercases and strips diacritics so "jose" finds "José". Matches the diacritic-insensitive
 *  sort (localeCompare sensitivity: 'base') — a name that sorts as if unaccented should also be
 *  findable by its unaccented spelling. */
const foldForSearch = (value: string) =>
    value
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase();

/** Case- and diacritic-insensitive substring match over every searchable person field. */
export function personMatchesQuery(person: StoredPerson, query: string): boolean {
    const needle = foldForSearch(query.trim());
    if (!needle) {
        return true;
    }
    return [person.name, person.email, person.phone, person.notes].some((field) => (field ? foldForSearch(field).includes(needle) : false));
}

/**
 * List order for the /people page: filter by the search query, then alphabetical by name with
 * archived people parked at the bottom (the "Unused" hint marks archive candidates).
 */
export function orderPeople(people: StoredPerson[], query: string): StoredPerson[] {
    const visible = people.filter((person) => personMatchesQuery(person, query));
    return [...sortByName(visible.filter((p) => !p.archived)), ...sortByName(visible.filter((p) => p.archived))];
}
