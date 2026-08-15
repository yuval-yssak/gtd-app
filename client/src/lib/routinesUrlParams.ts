import { readQueryParam } from './listQueryUrlParams';

export type RoutinesTab = 'nextAction' | 'calendar';
export type RoutinesView = 'list' | 'week';

/**
 * All /routines URL state. Defaults (nextAction tab, list view) are materialized as `undefined`
 * so TanStack Router's search serializer omits them from the URL entirely — only the
 * non-default selections (?tab=calendar, ?view=week) ever appear.
 */
export interface RoutinesUrlState {
    // `| undefined` is explicit because exactOptionalPropertyTypes is on and the parser
    // deliberately materializes unset values as `undefined`.
    q?: string | undefined;
    tab?: 'calendar' | undefined;
    view?: 'week' | undefined;
}

// 'nextAction' (the default) normalizes to undefined so a hand-written ?tab=nextAction
// resolves to the same clean URL state as no param at all; junk values are stripped.
const readTab = (raw: unknown): 'calendar' | undefined => (raw === 'calendar' ? 'calendar' : undefined);
const readView = (raw: unknown): 'week' | undefined => (raw === 'week' ? 'week' : undefined);

// Mapped optional-unknown shape so dot-notation reads don't trip TS4111 — same tradeoff as
// nextActionsUrlParams's RawNextActionsBag.
type RawRoutinesBag = { [K in keyof RoutinesUrlState]?: unknown };

// Used by validateSearch — junk values are stripped (never crash), valid ones typed.
export function parseRoutinesSearch(search: RawRoutinesBag): RoutinesUrlState {
    return { q: readQueryParam(search.q), tab: readTab(search.tab), view: readView(search.view) };
}
