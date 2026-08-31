import { useSyncExternalStore } from 'react';
import { getTodayIso, subscribeToDayChange } from '../lib/dayClock';

/**
 * Reactive local calendar date (YYYY-MM-DD) — re-renders the consumer when the app's shared day
 * clock crosses local midnight, so date-boundary filters (tickler, overdue) roll without a reload.
 */
export function useTodayIso(): string {
    return useSyncExternalStore(subscribeToDayChange, getTodayIso);
}
