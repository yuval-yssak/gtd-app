import { useCallback, useEffect, useRef, useState } from 'react';
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

/**
 * Fetches every enabled sync config across every logged-in account on this device, flattened
 * into picker options. Backed by `GET /calendar/all-sync-configs` so a single round-trip
 * yields the multi-account view; the server enumerates the device's Better Auth sessions and
 * pairs each user's integrations with their sync configs.
 */
export function useCalendarOptions(): { options: CalendarOption[]; isLoading: boolean } {
    const [options, setOptions] = useState<CalendarOption[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const isMountedRef = useRef(true);

    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
        };
    }, []);

    const fetchCalendarOptions = useCallback(async () => {
        try {
            const bundles = await getAllSyncConfigs();
            const flat = bundles.flatMap(toOptionsForBundle);
            if (isMountedRef.current) setOptions(flat);
        } catch {
            // Best-effort — if fetching fails, the picker simply won't appear.
        } finally {
            if (isMountedRef.current) setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchCalendarOptions();
    }, [fetchCalendarOptions]);

    return { options, isLoading };
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
