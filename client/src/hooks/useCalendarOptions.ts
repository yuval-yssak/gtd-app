import { use } from 'react';
import { type AccountSyncConfigsBundle, type CalendarSyncConfig, getAllSyncConfigs } from '../api/calendarApi';

export interface CalendarOption {
    configId: string;
    integrationId: string;
    /** Better Auth user ID — owner of the calendar. Lets the picker group by account and lets save-time logic record where to push. */
    userId: string;
    /** Email of the owning account — used as the group label in the picker UI. */
    accountEmail: string;
    /** Calendar display name (e.g. "Work", "Holidays"). Picker shows this as the row label. */
    displayName: string;
    /** True when this is the owning account's default calendar. */
    isDefault: boolean;
}

// Cached so two dialogs opening at once suspend on the same network round-trip and the result
// stays warm across navigation. The cache survives until the page reloads — accounts are added
// via reload-triggering flows so staleness here can't outlive a session.
let cached: Promise<CalendarOption[]> | null = null;

function loadCalendarOptions(): Promise<CalendarOption[]> {
    if (cached) {
        return cached;
    }
    cached = getAllSyncConfigs()
        .then((bundles) => bundles.flatMap(toOptionsForBundle))
        .catch(() => {
            // Best-effort — if the round-trip fails, the picker simply has no options.
            // Reset the cache so a later open retries instead of memoizing the failure.
            cached = null;
            return [];
        });
    return cached;
}

/**
 * Suspends until /calendar/all-sync-configs returns. Wrap call sites in a small Suspense boundary
 * (typically a CircularProgress in place of the calendar dropdown) so the rest of the dialog
 * renders immediately. Result is module-cached so reopening a dialog reuses the resolved options.
 */
export function useCalendarOptions(): { options: CalendarOption[] } {
    const options = use(loadCalendarOptions());
    return { options };
}

/**
 * Kicks the network round-trip off in the background so dialogs that later call
 * useCalendarOptions() find the cache warm. Called from the auth-layer boot effect — by the
 * time the user opens a clarify or edit dialog, the options are usually already resolved.
 * Safe to call multiple times; subsequent calls return the cached promise.
 */
export function prefetchCalendarOptions(): void {
    void loadCalendarOptions();
}

/** Test-only — drops the module cache so each spec starts cold. */
export function _resetCalendarOptionsCacheForTests(): void {
    cached = null;
}

/** Flattens one account bundle into options. Filters out disabled configs at this layer so callers don't have to. */
function toOptionsForBundle(bundle: AccountSyncConfigsBundle): CalendarOption[] {
    return bundle.integrations.flatMap((integration) =>
        integration.syncConfigs.filter((config) => config.enabled).map((config) => toOption(config, bundle.userId, bundle.accountEmail)),
    );
}

function toOption(config: CalendarSyncConfig, userId: string, accountEmail: string): CalendarOption {
    return {
        configId: config._id,
        integrationId: config.integrationId,
        userId,
        accountEmail,
        displayName: config.displayName ?? config.calendarId,
        isDefault: config.isDefault,
    };
}
