import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSyncConfigsBundle } from '../api/calendarApi';
import * as calendarApi from '../api/calendarApi';
import { _resetCalendarOptionsCacheForTests, CALENDAR_OPTIONS_RETRY_AFTER_FAILURE_MS, prefetchCalendarOptions } from '../hooks/useCalendarOptions';

const BUNDLE_A: AccountSyncConfigsBundle = {
    userId: 'user-A',
    accountEmail: 'a@example.com',
    integrations: [
        {
            _id: 'int-A',
            provider: 'google',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-01T00:00:00.000Z',
            syncConfigs: [
                {
                    _id: 'cfg-A1',
                    integrationId: 'int-A',
                    calendarId: 'cal-A1',
                    displayName: 'Work',
                    isDefault: true,
                    enabled: true,
                    user: 'user-A',
                    createdTs: '2026-01-01T00:00:00.000Z',
                    updatedTs: '2026-01-01T00:00:00.000Z',
                },
                // Disabled config — useCalendarOptions filters these out at the bundle layer.
                {
                    _id: 'cfg-A2',
                    integrationId: 'int-A',
                    calendarId: 'cal-A2',
                    displayName: 'Holidays',
                    isDefault: false,
                    enabled: false,
                    user: 'user-A',
                    createdTs: '2026-01-01T00:00:00.000Z',
                    updatedTs: '2026-01-01T00:00:00.000Z',
                },
            ],
        },
    ],
};

beforeEach(() => {
    _resetCalendarOptionsCacheForTests();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('useCalendarOptions cache', () => {
    it('prefetchCalendarOptions issues exactly one network call across many awaits', async () => {
        const spy = vi.spyOn(calendarApi, 'getAllSyncConfigs').mockResolvedValue([BUNDLE_A]);
        prefetchCalendarOptions();
        prefetchCalendarOptions();
        prefetchCalendarOptions();
        // Let the microtask queue flush.
        await Promise.resolve();
        await Promise.resolve();
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('a failure is not refetched by every read: the empty result holds until the retry window passes', async () => {
        vi.useFakeTimers();
        try {
            const spy = vi.spyOn(calendarApi, 'getAllSyncConfigs').mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce([BUNDLE_A]);
            prefetchCalendarOptions();
            await vi.advanceTimersByTimeAsync(0);
            // A re-render right after the failure reads the settled (empty) result — no new round-trip.
            prefetchCalendarOptions();
            await vi.advanceTimersByTimeAsync(0);
            expect(spy).toHaveBeenCalledTimes(1);

            // Once the window has passed, the next read retries instead of memoizing the failure forever.
            await vi.advanceTimersByTimeAsync(CALENDAR_OPTIONS_RETRY_AFTER_FAILURE_MS + 1);
            prefetchCalendarOptions();
            await vi.advanceTimersByTimeAsync(0);
            expect(spy).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });
});
