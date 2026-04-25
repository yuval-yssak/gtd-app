import type { StoredItem } from '../types/MyDB';
import { ALL_STATUSES, type SearchDateField, type SearchFilters } from './itemSearch';

export type SearchView = 'grouped' | 'flatChip' | 'flatMinimal' | 'table';

const VIEWS: ReadonlySet<string> = new Set<SearchView>(['grouped', 'flatChip', 'flatMinimal', 'table']);
const STATUS_SET: ReadonlySet<string> = new Set<StoredItem['status']>(ALL_STATUSES);
const DATE_FIELDS: ReadonlySet<string> = new Set<SearchDateField>(['createdTs', 'updatedTs']);

// All search-page URL state. Stored shape mirrors the canonical SearchFilters but
// uses array (rather than Set) for statuses so it survives URL serialization.
export interface SearchUrlState {
    q: string;
    statuses: StoredItem['status'][] | null; // null = default (active statuses)
    personId: string | null;
    contextId: string | null;
    dateField: SearchDateField;
    dateFrom: string | null;
    dateTo: string | null;
    view: SearchView;
}

export const DEFAULT_URL_STATE: SearchUrlState = {
    q: '',
    statuses: null,
    personId: null,
    contextId: null,
    dateField: 'updatedTs',
    dateFrom: null,
    dateTo: null,
    view: 'grouped',
};

// ISO date prefix is 10 chars (YYYY-MM-DD); reject anything that doesn't fit so a junk URL
// param doesn't slip into a comparison and silently exclude every item.
const isIsoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

const readString = (raw: unknown): string => (typeof raw === 'string' ? raw : '');

const readOptional = (raw: unknown): string | null => (typeof raw === 'string' && raw.length > 0 ? raw : null);

const readDate = (raw: unknown): string | null => {
    const s = readOptional(raw);
    return s && isIsoDate(s) ? s : null;
};

const readStatuses = (raw: unknown): StoredItem['status'][] | null => {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    const parts = raw.split(',').filter((s) => STATUS_SET.has(s));
    // An empty list after filtering means every value was invalid — treat as "use default"
    // rather than "match nothing", which would be confusing on a fresh navigation.
    return parts.length > 0 ? (parts as StoredItem['status'][]) : null;
};

const readDateField = (raw: unknown): SearchDateField => (typeof raw === 'string' && DATE_FIELDS.has(raw) ? (raw as SearchDateField) : 'updatedTs');

const readView = (raw: unknown): SearchView => (typeof raw === 'string' && VIEWS.has(raw) ? (raw as SearchView) : 'grouped');

// Mapped optional-unknown shape so we can read with dot notation without tripping TS4111
// (noPropertyAccessFromIndexSignature) — bracket notation would in turn trip Biome's
// useLiteralKeys rule, so neither path is clean against a plain Record<string, unknown>.
type RawSearchBag = { [K in keyof SearchUrlState]?: unknown };

// Used by validateSearch — receives the unparsed URL search bag and returns a typed,
// fully-populated state object.
export function parseSearchParams(search: RawSearchBag): SearchUrlState {
    return {
        q: readString(search.q),
        statuses: readStatuses(search.statuses),
        personId: readOptional(search.personId),
        contextId: readOptional(search.contextId),
        dateField: readDateField(search.dateField),
        dateFrom: readDate(search.dateFrom),
        dateTo: readDate(search.dateTo),
        view: readView(search.view),
    };
}

export function urlStateToFilters(state: SearchUrlState, defaultStatuses: ReadonlySet<StoredItem['status']>): SearchFilters {
    return {
        query: state.q,
        statuses: state.statuses ? new Set(state.statuses) : defaultStatuses,
        personId: state.personId,
        contextId: state.contextId,
        dateField: state.dateField,
        dateFrom: state.dateFrom,
        dateTo: state.dateTo,
    };
}
