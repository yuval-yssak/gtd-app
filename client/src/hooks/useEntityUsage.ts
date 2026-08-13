import { useMemo } from 'react';
import { useAppData } from '../contexts/AppDataProvider';
import { buildUsageIndex, type UsageIndex } from '../lib/entityUsage';

/**
 * Usage index over the UNFILTERED item set (`allItems`), so chip ranking stays stable when the
 * user toggles account visibility — a hidden account's references still count as usage.
 */
export function useEntityUsage(): UsageIndex {
    const { allItems } = useAppData();
    return useMemo(() => buildUsageIndex(allItems), [allItems]);
}
