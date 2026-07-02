import type { EnergyLevel } from '../types/MyDB';

export const TIME_FILTER_OPTIONS = [5, 30, 60] as const;
export type TimeFilterMinutes = (typeof TIME_FILTER_OPTIONS)[number];

const ENERGY_LEVELS: ReadonlySet<EnergyLevel> = new Set<EnergyLevel>(['low', 'medium', 'high']);
const isEnergyLevel = (s: string): s is EnergyLevel => (ENERGY_LEVELS as ReadonlySet<string>).has(s);

/**
 * All /next-actions URL filter state. Unset filters are `undefined` (not null) so TanStack
 * Router's search serializer omits them from the URL entirely. Each filter is single-select.
 */
export interface NextActionsUrlState {
    // `| undefined` is explicit because exactOptionalPropertyTypes is on and the parser
    // deliberately materializes unset filters as `undefined` values.
    context?: string | undefined; // StoredWorkContext._id
    person?: string | undefined; // StoredPerson._id
    energy?: EnergyLevel | undefined;
    time?: TimeFilterMinutes | undefined;
}

const readId = (raw: unknown): string | undefined => (typeof raw === 'string' && raw.length > 0 ? raw : undefined);

const readEnergy = (raw: unknown): EnergyLevel | undefined => (typeof raw === 'string' && isEnergyLevel(raw) ? raw : undefined);

// TanStack Router JSON-parses search values, so `?time=5` arrives as the number 5; a
// manually-edited URL could still surface a string, so both shapes are accepted.
const readTime = (raw: unknown): TimeFilterMinutes | undefined => {
    const minutes = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
    return TIME_FILTER_OPTIONS.find((option) => option === minutes);
};

// Mapped optional-unknown shape so dot-notation reads don't trip TS4111 — same tradeoff as
// searchUrlParams's RawSearchBag.
type RawNextActionsBag = { [K in keyof NextActionsUrlState]?: unknown };

// Used by validateSearch — invalid or junk values are stripped (never crash), valid ones typed.
export function parseNextActionsSearch(search: RawNextActionsBag): NextActionsUrlState {
    return {
        context: readId(search.context),
        person: readId(search.person),
        energy: readEnergy(search.energy),
        time: readTime(search.time),
    };
}
