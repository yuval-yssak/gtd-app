/**
 * /routines URL search state. Unset values are `undefined` (not null) so TanStack Router's
 * search serializer omits them from the URL entirely — same convention as nextActionsUrlParams.
 */
export interface RoutinesUrlState {
    // `| undefined` is explicit because exactOptionalPropertyTypes is on and the parser
    // deliberately materializes an unset query as `undefined`.
    q?: string | undefined;
}

// TanStack Router JSON-parses each search value, so a numeric-looking query typed into the
// search box (`?q=2024`) arrives as the number 2024 and a bare `?q=true` as a boolean —
// coerce those back to the string the user typed instead of dropping them.
const readQuery = (raw: unknown): string | undefined => {
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
type RawRoutinesBag = { [K in keyof RoutinesUrlState]?: unknown };

// Used by validateSearch — junk values are stripped (never crash), valid ones typed.
export function parseRoutinesSearch(search: RawRoutinesBag): RoutinesUrlState {
    return { q: readQuery(search.q) };
}
