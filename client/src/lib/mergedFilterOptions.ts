import { sortByName } from './sortByName';
import { hasAtLeastOne } from './typeUtils';

/**
 * One filter chip in the merged multi-account view. Each signed-in account owns its own copy of
 * common contexts/people ("agenda", "computer", …), so rendering one chip per entity shows
 * indistinguishable duplicates. Same-named entities collapse into a single option that filters
 * across every account's twin.
 */
export interface MergedFilterOption {
    /** Id written to the URL when the chip is clicked — lexicographically smallest of the group,
     *  so the produced link is stable regardless of entity iteration order. */
    canonicalId: string;
    name: string;
    /** Every entity id sharing the (case-insensitive, trimmed) name, across accounts. */
    ids: string[];
}

/** The URL's single stored filter id resolved against the merged options: which chip is active
 *  and the full id set items must match. Deriving both from one place keeps them from ever
 *  disagreeing (an applied filter with no lit chip). */
export interface SelectedFilterOption {
    /** The merged chip to render as active; undefined when the id resolves to no visible option
     *  (deleted entity) — the filter still applies via `ids`. */
    option: MergedFilterOption | undefined;
    ids: ReadonlySet<string>;
}

// Deliberately ASCII-level normalization only: no Unicode folding, so "Renée" and "Renee" stay
// separate chips (they are arguably different names; sortByName still places them adjacently).
const nameKey = (name: string) => name.trim().toLowerCase();

/** Collapses same-named entities into merged filter options, sorted A→Z like the chip rows. */
export function mergeFilterOptionsByName<T extends { _id: string; name: string }>(options: T[]): MergedFilterOption[] {
    const groups = sortByName(options).reduce((map, option) => {
        const key = nameKey(option.name);
        map.set(key, [...(map.get(key) ?? []), option]);
        return map;
    }, new Map<string, T[]>());
    return [...groups.values()].map((twins) => {
        if (!hasAtLeastOne(twins)) {
            throw new Error('unreachable: a name group always contains the member that created it');
        }
        const ids = twins.map((twin) => twin._id);
        const canonicalId = ids.reduce((a, b) => (a < b ? a : b));
        // Label from the canonical twin (trimmed) so it can't drift with casing/whitespace
        // variants or IDB iteration order.
        const canonical = twins.find((twin) => twin._id === canonicalId) ?? twins[0];
        return { canonicalId, name: canonical.name.trim(), ids };
    });
}

/**
 * Ids of every entity sharing the given id's (case-insensitive, trimmed) name — the twin group a
 * single stored filter id stands for. Used as the keep-set when cutting archived entities from a
 * filter row: dropping an archived twin from the pool would silently narrow the merged option's
 * match set. Unknown ids fall back to a singleton set; no id ⇒ empty set.
 */
export function sameNameIds(selectedId: string | undefined, allOptions: { _id: string; name: string }[]): ReadonlySet<string> {
    if (!selectedId) {
        return new Set();
    }
    const selectedName = allOptions.find((option) => option._id === selectedId)?.name;
    if (selectedName === undefined) {
        return new Set([selectedId]);
    }
    return new Set(allOptions.filter((option) => nameKey(option.name) === nameKey(selectedName)).map((option) => option._id));
}

/**
 * Live-facet cut of a filter row: only options actually referenced by the given ids survive —
 * a chip matching zero currently-visible items is pure noise. The active selection is exempt
 * (it must stay clickable to clear the filter even when it just filtered itself to zero rows).
 */
export function filterOptionsToReferenced(
    options: MergedFilterOption[],
    referencedIds: ReadonlySet<string>,
    selected: MergedFilterOption | undefined,
): MergedFilterOption[] {
    return options.filter((option) => option.canonicalId === selected?.canonicalId || option.ids.some((id) => referencedIds.has(id)));
}

/**
 * Resolves the URL's single stored id to the active merged chip and its matching id set. A deep
 * link may carry any twin's id, and the id's owner account may since have been visibility-hidden
 * (its entities absent from `merged`) — in that case the id's name, resolved via the unfiltered
 * `allOptions`, re-attaches it to the visible same-name group so the chip still lights up and the
 * still-visible twins keep matching. Ids unknown even to `allOptions` fall back to a singleton set
 * with no active chip (stale link to a deleted entity).
 */
export function resolveSelectedFilterOption(
    selectedId: string | undefined,
    merged: MergedFilterOption[],
    allOptions: { _id: string; name: string }[],
): SelectedFilterOption | undefined {
    if (!selectedId) {
        return undefined;
    }
    const direct = merged.find((option) => option.ids.includes(selectedId));
    if (direct) {
        return { option: direct, ids: new Set(direct.ids) };
    }
    const selectedName = allOptions.find((option) => option._id === selectedId)?.name;
    const byName = selectedName === undefined ? undefined : merged.find((option) => nameKey(option.name) === nameKey(selectedName));
    if (byName) {
        return { option: byName, ids: new Set([...byName.ids, selectedId]) };
    }
    return { option: undefined, ids: new Set([selectedId]) };
}
