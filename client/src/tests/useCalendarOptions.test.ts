import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSyncConfigsBundle } from '../api/calendarApi';
import * as calendarApi from '../api/calendarApi';
import { _resetCalendarOptionsCacheForTests, prefetchCalendarOptions } from '../hooks/useCalendarOptions';

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

    it('on rejection drops the cache so a later call retries instead of memoizing the failure', async () => {
        const spy = vi.spyOn(calendarApi, 'getAllSyncConfigs').mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce([BUNDLE_A]);
        prefetchCalendarOptions();
        // Drain microtasks until the catch handler that nulls the cache fires.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        // Second prefetch should issue a fresh network call rather than reusing the rejected promise.
        prefetchCalendarOptions();
        await Promise.resolve();
        await Promise.resolve();
        expect(spy).toHaveBeenCalledTimes(2);
    });
});
