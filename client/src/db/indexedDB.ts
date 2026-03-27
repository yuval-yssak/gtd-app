import type { IDBPDatabase } from 'idb';
import { openDB } from 'idb';
import type { MyDB } from '../types/MyDB';

export async function openAppDB(): Promise<IDBPDatabase<MyDB>> {
    return openDB<MyDB>('gtd-app', 2, {
        upgrade(db, oldVersion) {
            // Version 1: core stores
            if (oldVersion < 1) {
                const accounts = db.createObjectStore('accounts', { keyPath: 'id' });
                accounts.createIndex('email', 'email', { unique: true });
                db.createObjectStore('activeAccount');
                const items = db.createObjectStore('items', { keyPath: '_id' });
                items.createIndex('userId', 'userId', { unique: false });
                db.createObjectStore('syncOperations', { autoIncrement: true, keyPath: 'id' });
            }

            // Version 2: sync infrastructure + entity stores that were typed but never created
            if (oldVersion < 2) {
                db.createObjectStore('deviceSyncState', { keyPath: '_id' });

                const routines = db.createObjectStore('routines', { keyPath: '_id' });
                routines.createIndex('userId', 'userId', { unique: false });

                const people = db.createObjectStore('people', { keyPath: '_id' });
                people.createIndex('userId', 'userId', { unique: false });

                const workContexts = db.createObjectStore('workContexts', { keyPath: '_id' });
                workContexts.createIndex('userId', 'userId', { unique: false });
            }
        },
    });
}
