import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import type { MyDB } from '../types/MyDB';

export async function getOrCreateDeviceId(db: IDBPDatabase<MyDB>): Promise<string> {
    const existing = await db.get('deviceSyncState', 'local');
    if (existing) return existing.deviceId;

    const deviceId = crypto.randomUUID();
    await db.put('deviceSyncState', { _id: 'local', deviceId, lastSyncedTs: dayjs(0).toISOString() });
    return deviceId;
}

export async function getLastSyncedTs(db: IDBPDatabase<MyDB>): Promise<string> {
    const state = await db.get('deviceSyncState', 'local');
    // Epoch start means "give me everything" — correct behaviour for a device syncing for the first time
    return state?.lastSyncedTs ?? dayjs(0).toISOString();
}

export async function setLastSyncedTs(db: IDBPDatabase<MyDB>, ts: string): Promise<void> {
    const state = await db.get('deviceSyncState', 'local');
    if (!state) return;
    await db.put('deviceSyncState', { ...state, lastSyncedTs: ts });
}
