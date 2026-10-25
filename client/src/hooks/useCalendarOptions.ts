import dayjs, { type Dayjs } from 'dayjs';
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
// When the last load failed. A failed load settles on an empty list and stays cached: dropping it
// would make every re-render of a use() reader start a new request and suspend again, so the editor
// never mounts and the request repeats forever.
let failedAt: Dayjs | null = null;

/** How long a failed load is served (as no options) before a read retries it in the background. */
export const CALENDAR_OPTIONS_RETRY_AFTER_FAILURE_MS = 30_000;

function isRetryDue(): boolean {
    return failedAt !== null && dayjs().diff(failedAt) > CALENDAR_OPTIONS_RETRY_AFTER_FAILURE_MS;
}

function loadCalendarOptions(): Promise<CalendarOption[]> {
    if (cached && isRetryDue()) {
        revalidateInBackground();
    }
    cached ??= fetchCalendarOptions();
    return cached;
}

function fetchCalendarOptions(): Promise<CalendarOption[]> {
    return getAllSyncConfigs()
        .then((bundles) => bundles.flatMap(toOptionsForBundle))
        .catch(() => {
            // Best-effort — if the round-trip fails, the picker simply has no options until a
            // read after the retry window fetches again.
            failedAt = dayjs();
            return [];
        });
}

/**
 * Stale-while-revalidate: mounted readers keep the settled (empty) result while the retry runs —
 * handing use() a pending promise would suspend every open editor behind its fallback, and offline
 * that would recur every retry window. A failed retry re-arms `failedAt` and keeps the old result.
 */
function revalidateInBackground(): void {
    failedAt = null;
    const retry = fetchCalendarOptions();
    void retry.then(() => {
        if (failedAt === null) {
            cached = retry;
        }
    });
}

/**
 * Suspends until /calendar/all-sync-configs returns; a Suspense boundary around the call site
 * decides what shows meanwhile. Result is module-cached so reopening an editor reuses the
 * resolved options.
 */
export function useCalendarOptions(): { options: CalendarOption[] } {
    const options = use(loadCalendarOptions());
    return { options };
}

/**
 * Kicks the network round-trip off in the background so editors that later call
 * useCalendarOptions() find the cache warm. Called from the auth-layer boot effect — by the
 * time the user opens an item or routine editor, the options are usually already resolved.
 * Safe to call multiple times; subsequent calls return the cached promise.
 */
export function prefetchCalendarOptions(): void {
    void loadCalendarOptions();
}

/** Test-only — drops the module cache so each spec starts cold. */
export function _resetCalendarOptionsCacheForTests(): void {
    cached = null;
    failedAt = null;
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
