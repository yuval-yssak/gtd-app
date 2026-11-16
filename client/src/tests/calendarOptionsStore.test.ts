import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSyncConfigsBundle, CalendarSyncConfig } from '../api/calendarApi';
import { readStoredCalendarOptions, storeCalendarOptionBundles } from '../db/calendarOptionsStore';
import type { MyDB } from '../types/MyDB';
import { openTestDB, seedAccountOnDevice } from './openTestDB';

function syncConfig(userId: string, id: string, displayName: string, overrides: { enabled?: boolean; isDefault?: boolean } = {}): CalendarSyncConfig {
    return {
        _id: id,
        integrationId: `int-${userId}`,
        calendarId: `cal-${id}`,
        displayName,
        isDefault: overrides.isDefault ?? false,
        enabled: overrides.enabled ?? true,
        user: userId,
        createdTs: '2026-01-01T00:00:00.000Z',
        updatedTs: '2026-01-01T00:00:00.000Z',
    };
}

function bundleFor(userId: string, configs: CalendarSyncConfig[]): AccountSyncConfigsBundle {
    return {
        userId,
        accountEmail: `${userId}@example.com`,
        integrations: [
            { _id: `int-${userId}`, provider: 'google', createdTs: '2026-01-01T00:00:00.000Z', updatedTs: '2026-01-01T00:00:00.000Z', syncConfigs: configs },
        ],
    };
}

let db: IDBPDatabase<MyDB>;

beforeEach(async () => {
    db = await openTestDB();
    await seedAccountOnDevice(db, 'user-A');
    await seedAccountOnDevice(db, 'user-B');
});

afterEach(() => {
    vi.useRealTimers();
    db.close();
});

describe('calendar options on the device', () => {
    it('reads nothing before the first fetch has been stored', async () => {
        expect(await readStoredCalendarOptions(db)).toEqual([]);
    });

    it('stores enabled calendars per account and reads them back as picker options', async () => {
        await storeCalendarOptionBundles(db, [
            bundleFor('user-A', [syncConfig('user-A', 'cfg-A1', 'Work', { isDefault: true }), syncConfig('user-A', 'cfg-A2', 'Holidays', { enabled: false })]),
            bundleFor('user-B', [syncConfig('user-B', 'cfg-B1', 'Home', { isDefault: true })]),
        ]);

        expect(await readStoredCalendarOptions(db)).toEqual([
            { configId: 'cfg-A1', integrationId: 'int-user-A', userId: 'user-A', accountEmail: 'user-A@example.com', displayName: 'Work', isDefault: true },
            { configId: 'cfg-B1', integrationId: 'int-user-B', userId: 'user-B', accountEmail: 'user-B@example.com', displayName: 'Home', isDefault: true },
        ]);
    });

    it("replaces an account's stored calendars with the latest fetch", async () => {
        await storeCalendarOptionBundles(db, [bundleFor('user-A', [syncConfig('user-A', 'cfg-A1', 'Work')])]);
        await storeCalendarOptionBundles(db, [bundleFor('user-A', [syncConfig('user-A', 'cfg-A1', 'Work (renamed)')])]);

        expect((await readStoredCalendarOptions(db)).map((option) => option.displayName)).toEqual(['Work (renamed)']);
    });

    it('keeps the last known calendars of an account the latest fetch did not mention', async () => {
        await storeCalendarOptionBundles(db, [bundleFor('user-B', [syncConfig('user-B', 'cfg-B1', 'Home')])]);
        await storeCalendarOptionBundles(db, [bundleFor('user-A', [syncConfig('user-A', 'cfg-A1', 'Work')])]);

        expect((await readStoredCalendarOptions(db)).map((option) => option.configId).sort()).toEqual(['cfg-A1', 'cfg-B1']);
    });

    it('falls back to the calendar id when a calendar has no display name', async () => {
        const { displayName: _omitted, ...unnamed } = syncConfig('user-A', 'cfg-A1', 'unused');
        await storeCalendarOptionBundles(db, [bundleFor('user-A', [unnamed])]);

        expect((await readStoredCalendarOptions(db)).map((option) => option.displayName)).toEqual(['cal-cfg-A1']);
    });

    it('stamps when the list was fetched', async () => {
        // Date only: fake-indexeddb schedules its callbacks on real timers.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(dayjs('2026-11-16T10:00:00.000Z').valueOf());

        await storeCalendarOptionBundles(db, [bundleFor('user-A', [])]);

        expect((await db.get('calendarOptions', 'user-A'))?.fetchedTs).toBe('2026-11-16T10:00:00.000Z');
    });

    it('drops the response for an account signed out while the request was in flight', async () => {
        await storeCalendarOptionBundles(db, [bundleFor('user-gone', [syncConfig('user-gone', 'cfg-X', 'Ghost')])]);

        expect(await db.get('calendarOptions', 'user-gone')).toBeUndefined();
    });
});
