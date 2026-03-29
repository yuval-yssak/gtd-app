import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import type { EnergyLevel, MyDB, StoredItem } from '../types/MyDB';

export async function getItemsByUser(db: IDBPDatabase<MyDB>, userId: string): Promise<StoredItem[]> {
    return db.getAllFromIndex('items', 'userId', userId);
}

export async function putItem(db: IDBPDatabase<MyDB>, item: StoredItem): Promise<void> {
    console.log('putting item', item);
    await db.put('items', item);
}

export async function deleteItemById(db: IDBPDatabase<MyDB>, _id: string): Promise<void> {
    await db.delete('items', _id);
}

export async function bulkPutItems(db: IDBPDatabase<MyDB>, items: StoredItem[]): Promise<void> {
    const tx = db.transaction('items', 'readwrite');
    // tx.done must be included in the Promise.all — awaiting it separately after the puts
    // would miss writes that haven't resolved yet and silently skip them.
    await Promise.all([...items.map((item) => tx.store.put(item)), tx.done]);
}

export async function getItemsByStatus(db: IDBPDatabase<MyDB>, userId: string, status: StoredItem['status']): Promise<StoredItem[]> {
    const all = await db.getAllFromIndex('items', 'userId', userId);
    return all.filter((item) => item.status === status);
}

export interface NextActionFilters {
    energy?: EnergyLevel;
    maxMinutes?: number;
    focus?: boolean;
    urgent?: boolean;
    workContextId?: string;
}

export async function getActiveNextActions(db: IDBPDatabase<MyDB>, userId: string, filters: NextActionFilters = {}): Promise<StoredItem[]> {
    const today = dayjs().format('YYYY-MM-DD');
    const all = await db.getAllFromIndex('items', 'userId', userId);

    return all.filter((item) => {
        if (item.status !== 'nextAction') return false;
        // ignoreBefore hides the item until that date passes (tickler pattern)
        if (item.ignoreBefore && item.ignoreBefore > today) return false;
        if (filters.energy && item.energy !== filters.energy) return false;
        if (filters.maxMinutes !== undefined && (item.time === undefined || item.time > filters.maxMinutes)) return false;
        if (filters.focus !== undefined && item.focus !== filters.focus) return false;
        if (filters.urgent !== undefined && item.urgent !== filters.urgent) return false;
        if (filters.workContextId && !item.workContextIds?.includes(filters.workContextId)) return false;
        return true;
    });
}

export async function getUpcomingCalendarItems(db: IDBPDatabase<MyDB>, userId: string): Promise<StoredItem[]> {
    const all = await db.getAllFromIndex('items', 'userId', userId);
    return all.filter((item) => item.status === 'calendar').sort((a, b) => (a.timeStart ?? '').localeCompare(b.timeStart ?? ''));
}

export async function getOverdueItems(db: IDBPDatabase<MyDB>, userId: string): Promise<StoredItem[]> {
    const today = dayjs().format('YYYY-MM-DD');
    const all = await db.getAllFromIndex('items', 'userId', userId);
    return all.filter((item) => (item.status === 'nextAction' || item.status === 'waitingFor') && item.expectedBy !== undefined && item.expectedBy < today);
}
