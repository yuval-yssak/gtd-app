import type { IDBPDatabase } from 'idb';
import { openDB } from 'idb';
import type { MyDB } from '../types/MyDB';

export async function openAppDB(): Promise<IDBPDatabase<MyDB>> {
    return openDB<MyDB>('gtd-app', 1, {
        upgrade(db) {
            const accounts = db.createObjectStore('accounts', { keyPath: 'id' });
            accounts.createIndex('email', 'email', { unique: true });
            db.createObjectStore('activeAccount');
            const items = db.createObjectStore('items', { keyPath: '_id' });
            items.createIndex('userId', 'userId', { unique: false });
            db.createObjectStore('syncOperations', { autoIncrement: true, keyPath: 'id' });
        },
    });
}
