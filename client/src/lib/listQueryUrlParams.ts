/**
 * Shared `q` URL search state for list pages with an in-page search field (/routines,
 * /next-actions, /inbox, /calendar). Unset values are `undefined` (not null) so TanStack
 * Router's search serializer omits them from the URL entirely.
 */
export interface ListQueryUrlState {
    // `| undefined` is explicit because exactOptionalPropertyTypes is on and the parser
    // deliberately materializes an unset query as `undefined`.
    q?: string | undefined;
}

// TanStack Router JSON-parses each search value, so a numeric-looking query typed into the
// search box (`?q=2024`) arrives as the number 2024 and a bare `?q=true` as a boolean —
// coerce those back to the string the user typed instead of dropping them.
export const readQueryParam = (raw: unknown): string | undefined => {
    if (typeof raw === 'string') {
        return raw.length > 0 ? raw : undefined;
    }
    if (typeof raw === 'number' || typeof raw === 'boolean') {
        return String(raw);
    }
    return undefined;
};

// Mapped optional-unknown shape so dot-notation reads don't trip TS4111 — same tradeoff as
// nextActionsUrlParams's RawNextActionsBag.
type RawListQueryBag = { [K in keyof ListQueryUrlState]?: unknown };

// Used by validateSearch — junk values are stripped (never crash), valid ones typed.
export function parseListQuerySearch(search: RawListQueryBag): ListQueryUrlState {
    return { q: readQueryParam(search.q) };
}
