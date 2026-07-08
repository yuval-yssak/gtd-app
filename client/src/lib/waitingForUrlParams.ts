export type WaitingForSortBy = 'person' | 'date';

/**
 * /waiting-for URL search state. Unset `sortBy` is `undefined` (not null) so TanStack Router's
 * search serializer omits it from the URL entirely — same convention as listQueryUrlParams.
 */
export interface WaitingForUrlState {
    sortBy?: WaitingForSortBy | undefined;
}

const readSortBy = (raw: unknown): WaitingForSortBy | undefined => (raw === 'date' ? 'date' : undefined);

// Mapped optional-unknown shape so dot-notation reads don't trip TS4111 — same tradeoff as
// listQueryUrlParams's RawListQueryBag.
type RawWaitingForBag = { [K in keyof WaitingForUrlState]?: unknown };

// Used by validateSearch — junk values are stripped (never crash), valid ones typed.
export function parseWaitingForSearch(search: RawWaitingForBag): WaitingForUrlState {
    return { sortBy: readSortBy(search.sortBy) };
}
