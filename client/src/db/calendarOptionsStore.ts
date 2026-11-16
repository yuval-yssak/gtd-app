import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import type { AccountSyncConfigsBundle, CalendarSyncConfig } from '../api/calendarApi';
import type { CalendarOption, MyDB } from '../types/MyDB';
import { writeIfAccountOnDevice } from './accountHelpers';

/** Every account's last fetched calendars, flattened for the picker. */
export async function readStoredCalendarOptions(db: IDBPDatabase<MyDB>): Promise<CalendarOption[]> {
    const rows = await db.getAll('calendarOptions');
    return rows.flatMap((row) => row.options);
}

/**
 * Replaces each fetched account's stored calendars. An account the response does not mention keeps
 * its last known list — offline-first: a stale list beats none. Signing out wipes it.
 */
export async function storeCalendarOptionBundles(db: IDBPDatabase<MyDB>, bundles: AccountSyncConfigsBundle[]): Promise<void> {
    const fetchedTs = dayjs().toISOString();
    await Promise.all(
        bundles.map((bundle) =>
            // An account signed out while the request was in flight must not get its row back.
            writeIfAccountOnDevice(db, bundle.userId, async () => {
                await db.put('calendarOptions', { userId: bundle.userId, accountEmail: bundle.accountEmail, options: toCalendarOptions(bundle), fetchedTs });
            }),
        ),
    );
}

/** Flattens one account bundle into options, keeping only the calendars syncing is enabled for. */
function toCalendarOptions(bundle: AccountSyncConfigsBundle): CalendarOption[] {
    return bundle.integrations.flatMap((integration) =>
        integration.syncConfigs.filter((config) => config.enabled).map((config) => toCalendarOption(config, bundle)),
    );
}

function toCalendarOption(config: CalendarSyncConfig, { userId, accountEmail }: AccountSyncConfigsBundle): CalendarOption {
    return {
        configId: config._id,
        integrationId: config.integrationId,
        userId,
        accountEmail,
        displayName: config.displayName || config.calendarId,
        isDefault: config.isDefault,
    };
}
