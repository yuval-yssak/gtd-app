import dayjs from 'dayjs';
import type { StoredItem } from '../types/MyDB';
import { ACTIVE_STATUSES, ALL_STATUSES, type SearchDateField, type SearchFilters } from './itemSearch';

export type SearchView = 'grouped' | 'flatChip' | 'flatMinimal' | 'table';

const VIEWS: ReadonlySet<SearchView> = new Set<SearchView>(['grouped', 'flatChip', 'flatMinimal', 'table']);
const STATUS_SET: ReadonlySet<StoredItem['status']> = new Set<StoredItem['status']>(ALL_STATUSES);
const DATE_FIELDS: ReadonlySet<SearchDateField> = new Set<SearchDateField>(['createdTs', 'updatedTs']);

const isStatus = (s: string): s is StoredItem['status'] => (STATUS_SET as ReadonlySet<string>).has(s);
export const isDateField = (s: string): s is SearchDateField => (DATE_FIELDS as ReadonlySet<string>).has(s);
const isView = (s: string): s is SearchView => (VIEWS as ReadonlySet<string>).has(s);

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

// Reject anything that doesn't strictly match YYYY-MM-DD with a real calendar date so a
// junk URL param doesn't slip into a comparison and silently exclude every item. dayjs
// without strict-mode normalizes overflow (2026-13-01 → 2027-01-01), so we round-trip
// through format() and require equality to catch impossible months/days.
const isIsoDate = (s: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const parsed = dayjs(s);
    return parsed.isValid() && parsed.format('YYYY-MM-DD') === s;
};

const readString = (raw: unknown): string => (typeof raw === 'string' ? raw : '');

const readOptional = (raw: unknown): string | null => (typeof raw === 'string' && raw.length > 0 ? raw : null);

const readDate = (raw: unknown): string | null => {
    const s = readOptional(raw);
    return s && isIsoDate(s) ? s : null;
};

const readStatuses = (raw: unknown): StoredItem['status'][] | null => {
    // TanStack Router JSON-parses search values, so writes from the app round-trip as arrays;
    // we still accept comma-separated strings so manually-typed URLs work too.
    if (Array.isArray(raw)) {
        return raw.filter((v): v is string => typeof v === 'string').filter(isStatus);
    }
    if (typeof raw !== 'string' || raw.length === 0) return null;
    const parts = raw.split(',').filter(isStatus);
    // An empty list after filtering means every value was invalid — treat as "use default"
    // rather than "match nothing", which would be confusing on a fresh navigation.
    return parts.length > 0 ? parts : null;
};

const readDateField = (raw: unknown): SearchDateField => (typeof raw === 'string' && isDateField(raw) ? raw : 'updatedTs');

const readView = (raw: unknown): SearchView => (typeof raw === 'string' && isView(raw) ? raw : 'grouped');

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

const DEFAULT_STATUS_SET: ReadonlySet<StoredItem['status']> = new Set(ACTIVE_STATUSES);

export function urlStateToFilters(state: SearchUrlState): SearchFilters {
    return {
        query: state.q,
        statuses: state.statuses ? new Set(state.statuses) : DEFAULT_STATUS_SET,
        personId: state.personId,
        contextId: state.contextId,
        dateField: state.dateField,
        dateFrom: state.dateFrom,
        dateTo: state.dateTo,
    };
}
