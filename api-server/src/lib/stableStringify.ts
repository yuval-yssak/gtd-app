/**
 * Deterministic JSON serialization with object keys sorted recursively, so two structurally-equal
 * values produce byte-identical strings regardless of key insertion order. Used to deep-equal
 * operation snapshots when collapsing perpetual-no-op-update bloat: Mongo preserves per-doc key
 * order, but sorting keeps the comparison robust against ordering drift across documents.
 *
 * Arrays keep their order (order is semantic for arrays like `peopleIds`); only object keys sort.
 */
export function stableStringify(value: unknown): string {
    return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortKeysDeep);
    }
    if (value !== null && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return Object.fromEntries(entries.map(([key, nested]) => [key, sortKeysDeep(nested)]));
    }
    return value;
}
