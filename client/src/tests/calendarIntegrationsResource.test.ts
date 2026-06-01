import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarIntegration, CalendarSyncConfig, GoogleCalendar } from '../api/calendarApi';

// Mock the API layer so the resource's fetches are deterministic and side-effect free.
vi.mock('../api/calendarApi', () => ({
    listIntegrations: vi.fn(),
    listSyncConfigs: vi.fn(),
    listCalendars: vi.fn(),
}));

import { listCalendars, listIntegrations, listSyncConfigs } from '../api/calendarApi';
import {
    _resetCalendarIntegrationsResourceForTests,
    getCalendarIntegrationsResource,
    invalidateCalendarIntegrationsResource,
} from '../data/calendarIntegrationsResource';

function makeIntegration(id: string, createdTs = '2026-01-01T00:00:00.000Z'): CalendarIntegration {
    return { _id: id, provider: 'google', createdTs, updatedTs: createdTs };
}

function makeConfig(id: string, integrationId: string, calendarId: string): CalendarSyncConfig {
    return {
        _id: id,
        integrationId,
        user: 'user-A',
        calendarId,
        enabled: true,
        isDefault: false,
        createdTs: '2026-01-01T00:00:00.000Z',
        updatedTs: '2026-01-01T00:00:00.000Z',
    };
}

const CALENDARS: GoogleCalendar[] = [{ id: 'cal-1', name: 'Work', primary: false, accessRole: 'owner' }];

beforeEach(() => {
    _resetCalendarIntegrationsResourceForTests();
    vi.mocked(listIntegrations).mockResolvedValue([makeIntegration('int-1')]);
    vi.mocked(listSyncConfigs).mockResolvedValue([makeConfig('cfg-1', 'int-1', 'cal-1')]);
    vi.mocked(listCalendars).mockResolvedValue(CALENDARS);
});

afterEach(() => {
    vi.clearAllMocks();
});

describe('getCalendarIntegrationsResource', () => {
    it('bundles each integration with its sync configs and calendars in one resolve', async () => {
        const details = await getCalendarIntegrationsResource();
        expect(details).toHaveLength(1);
        const [detail] = details;
        if (!detail) throw new Error('expected one integration detail');
        expect(detail.integration._id).toBe('int-1');
        expect(detail.syncConfigs).toHaveLength(1);
        expect(detail.calendars).toEqual(CALENDARS);
    });

    it('returns the same promise on repeat calls so Suspense dedupes', () => {
        const first = getCalendarIntegrationsResource();
        const second = getCalendarIntegrationsResource();
        expect(second).toBe(first);
    });

    it('fetches integrations exactly once while the cache is warm', async () => {
        await getCalendarIntegrationsResource();
        await getCalendarIntegrationsResource();
        expect(listIntegrations).toHaveBeenCalledTimes(1);
    });

    it('degrades to calendars: null when the calendar-list fetch fails, keeping the row usable', async () => {
        _resetCalendarIntegrationsResourceForTests();
        vi.mocked(listCalendars).mockRejectedValueOnce(new Error('network'));
        const details = await getCalendarIntegrationsResource();
        const [detail] = details;
        if (!detail) throw new Error('expected one integration detail');
        // Sync configs still load; only the calendar list is null.
        expect(detail.calendars).toBeNull();
        expect(detail.syncConfigs).toHaveLength(1);
    });

    it('isolates a calendar-list failure to the one integration that failed', async () => {
        _resetCalendarIntegrationsResourceForTests();
        vi.mocked(listIntegrations).mockResolvedValue([makeIntegration('int-1'), makeIntegration('int-2')]);
        // Only int-1's calendar list rejects; int-2 must still resolve its calendars.
        vi.mocked(listCalendars).mockImplementation((id) => (id === 'int-1' ? Promise.reject(new Error('boom')) : Promise.resolve(CALENDARS)));
        const [first, second] = await getCalendarIntegrationsResource();
        expect(first?.calendars).toBeNull();
        expect(second?.calendars).toEqual(CALENDARS);
    });

    it('clears the cache on rejection so a remount retries instead of replaying the failure', async () => {
        _resetCalendarIntegrationsResourceForTests();
        vi.mocked(listIntegrations).mockRejectedValueOnce(new Error('500'));
        await expect(getCalendarIntegrationsResource()).rejects.toThrow('500');
        // The next read must re-fetch (mock now resolves) rather than return the rejected promise.
        const details = await getCalendarIntegrationsResource();
        expect(details).toHaveLength(1);
        expect(listIntegrations).toHaveBeenCalledTimes(2);
    });
});

describe('invalidateCalendarIntegrationsResource', () => {
    it('builds a fresh promise and the next get returns it', async () => {
        const before = getCalendarIntegrationsResource();
        const invalidated = invalidateCalendarIntegrationsResource();
        expect(invalidated).not.toBe(before);
        expect(getCalendarIntegrationsResource()).toBe(invalidated);
    });

    it('last-write-wins on the cache slot when invalidated while a prior load is pending', async () => {
        const stale = getCalendarIntegrationsResource();
        const fresh = invalidateCalendarIntegrationsResource();
        // The cache now points at the fresh promise even though `stale` never resolved-then-settled
        // the cache; the next consumer reads the fresh one.
        expect(fresh).not.toBe(stale);
        expect(getCalendarIntegrationsResource()).toBe(fresh);
        await Promise.all([stale, fresh]);
    });

    it('re-reads the API so a refresh sees newly added sync configs', async () => {
        const initial = await getCalendarIntegrationsResource();
        const [initialDetail] = initial;
        if (!initialDetail) throw new Error('expected one integration detail');
        expect(initialDetail.syncConfigs).toHaveLength(1);

        // Server now reports a second synced calendar on the same integration.
        vi.mocked(listSyncConfigs).mockResolvedValue([makeConfig('cfg-1', 'int-1', 'cal-1'), makeConfig('cfg-2', 'int-1', 'cal-2')]);
        const refreshed = await invalidateCalendarIntegrationsResource();
        const [refreshedDetail] = refreshed;
        if (!refreshedDetail) throw new Error('expected one integration detail');
        expect(refreshedDetail.syncConfigs).toHaveLength(2);
    });
});
