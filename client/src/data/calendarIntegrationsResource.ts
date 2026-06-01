import { type CalendarIntegration, type CalendarSyncConfig, type GoogleCalendar, listCalendars, listIntegrations, listSyncConfigs } from '../api/calendarApi';

/**
 * One integration enriched with everything the settings UI needs to render its row in a single
 * reveal: the per-integration sync configs and the available Google Calendar list. Pre-bundling
 * these means the Suspense boundary resolves once — instead of the old cascade of three independent
 * fetches that each shifted the layout as they landed.
 */
export interface IntegrationWithDetails {
    integration: CalendarIntegration;
    syncConfigs: CalendarSyncConfig[];
    /** null when the calendar list fetch failed — the row still renders, just without add/resolve. */
    calendars: GoogleCalendar[] | null;
}

// Module-level cache so two consumers `use()` the same promise (Suspense dedupe) and the result
// stays warm across navigation. Mutations call `invalidate…` to drop it and re-read in a transition.
//
// Account scope: this cache is intentionally NOT keyed by account. Correctness across accounts
// relies on the active-account switch in useAccounts performing a hard `window.location.href`
// reload, which tears down this module and its `cached` promise. If account switching ever becomes
// a soft (in-SPA) navigation, this cache must be keyed/reset on switch or it will leak one account's
// integrations into another.
let cached: Promise<IntegrationWithDetails[]> | null = null;

/**
 * Returns the stable promise for the full integrations tree. Repeat calls return the *same*
 * reference until invalidated — that identity is what lets `use()` dedupe and keep the resolved
 * value across re-renders.
 */
export function getCalendarIntegrationsResource(): Promise<IntegrationWithDetails[]> {
    if (cached) {
        return cached;
    }
    cached = loadIntegrationsWithDetails();
    return cached;
}

/**
 * Drops the cache and returns a fresh promise. Callers swap the returned promise into render state
 * inside `startTransition` so the existing UI keeps showing until the new tree resolves — no
 * fallback flash on refresh.
 */
export function invalidateCalendarIntegrationsResource(): Promise<IntegrationWithDetails[]> {
    cached = loadIntegrationsWithDetails();
    return cached;
}

function loadIntegrationsWithDetails(): Promise<IntegrationWithDetails[]> {
    // Build the chain first, then attach the cache-clearing rejection handler to the SAME promise
    // consumers hold — so the rejection is always observed (no dangling unhandled rejection) and the
    // next read (e.g. the inline error boundary's Retry, which remounts) re-fetches instead of
    // replaying the stale rejected promise forever.
    const inFlight = listIntegrations().then((integrations) => Promise.all(integrations.map(loadDetailsFor)));
    inFlight.catch(() => {
        if (cached === inFlight) {
            cached = null;
        }
    });
    return inFlight;
}

async function loadDetailsFor(integration: CalendarIntegration): Promise<IntegrationWithDetails> {
    // Sync configs and the calendar list are independent reads — fetch them together so the row
    // resolves as fast as its slowest dependency, not the sum of both. A calendar-list failure is
    // non-fatal: the row still lists synced calendars, just without name resolution or "add".
    const [syncConfigs, calendars] = await Promise.all([listSyncConfigs(integration._id), listCalendars(integration._id).catch(() => null)]);
    return { integration, syncConfigs, calendars };
}

/** Test-only — drops the module cache so each spec starts cold. */
export function _resetCalendarIntegrationsResourceForTests(): void {
    cached = null;
}
