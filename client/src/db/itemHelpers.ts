import type { IDBPDatabase } from 'idb';
import type { MyDB, StoredItem } from '../types/MyDB';

export async function getItemsByUser(db: IDBPDatabase<MyDB>, userId: string): Promise<StoredItem[]> {
    return db.getAllFromIndex('items', 'userId', userId);
}

export async function putItem(db: IDBPDatabase<MyDB>, item: StoredItem): Promise<void> {
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
