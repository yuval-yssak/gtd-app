export type SearchTableColumnId = 'title' | 'status' | 'updated' | 'created' | 'expectedBy' | 'people' | 'contexts';

export interface SearchTableColumnDef {
    id: SearchTableColumnId;
    label: string;
    // Title is structural — always shown. Other columns are user-toggleable.
    fixed?: boolean;
}

export const SEARCH_TABLE_COLUMNS: readonly SearchTableColumnDef[] = [
    { id: 'title', label: 'Title', fixed: true },
    { id: 'status', label: 'Status' },
    { id: 'updated', label: 'Updated' },
    { id: 'created', label: 'Created' },
    { id: 'expectedBy', label: 'Expected by' },
    { id: 'people', label: 'People' },
    { id: 'contexts', label: 'Contexts' },
];

const STORAGE_KEY = 'gtd:searchTableColumns';

const ALL_IDS: ReadonlySet<SearchTableColumnId> = new Set(SEARCH_TABLE_COLUMNS.map((c) => c.id));

const DEFAULT_VISIBLE: ReadonlySet<SearchTableColumnId> = new Set<SearchTableColumnId>(['title', 'status', 'updated', 'expectedBy']);

const isColumnId = (v: unknown): v is SearchTableColumnId => typeof v === 'string' && (ALL_IDS as ReadonlySet<string>).has(v);

// Stored as JSON array. Robust to corrupt values (parse/shape errors fall back to defaults).
export function loadVisibleColumns(): Set<SearchTableColumnId> {
    if (typeof localStorage === 'undefined') return new Set(DEFAULT_VISIBLE);
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set(DEFAULT_VISIBLE);
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return new Set(DEFAULT_VISIBLE);
        const ids = parsed.filter(isColumnId);
        // Title is always visible regardless of stored state — guarantees the table is never blank.
        return new Set<SearchTableColumnId>(['title', ...ids]);
    } catch {
        return new Set(DEFAULT_VISIBLE);
    }
}

export function saveVisibleColumns(visible: ReadonlySet<SearchTableColumnId>) {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...visible]));
}
