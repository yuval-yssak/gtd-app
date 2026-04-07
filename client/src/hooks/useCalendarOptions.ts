import { useCallback, useEffect, useRef, useState } from 'react';
import { type CalendarSyncConfig, listIntegrations, listSyncConfigs } from '../api/calendarApi';

export interface CalendarOption {
    configId: string;
    integrationId: string;
    displayName: string;
    isDefault: boolean;
}

/** Fetches all enabled sync configs across integrations, flattened into picker options. */
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
            const integrations = await listIntegrations();
            const configLists = await Promise.all(integrations.map((i) => listSyncConfigs(i._id)));
            const flat = configLists
                .flat()
                .filter((c) => c.enabled)
                .map(toOption);
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

function toOption(config: CalendarSyncConfig): CalendarOption {
    return {
        configId: config._id,
        integrationId: config.integrationId,
        displayName: config.displayName ?? config.calendarId,
        isDefault: config.isDefault,
    };
}
