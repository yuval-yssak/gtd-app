import { openDB } from 'idb'
import type { IDBPDatabase } from 'idb'
import type { MyDB } from '../types/MyDB'

export async function openAppDB(): Promise<IDBPDatabase<MyDB>> {
    return openDB<MyDB>('gtd-app', 2, {
        upgrade(db, oldVersion) {
            if (oldVersion < 1) {
                const accounts = db.createObjectStore('accounts', { keyPath: 'id' })
                accounts.createIndex('email', 'email', { unique: true })
                db.createObjectStore('activeAccount')
            }
            if (oldVersion < 2) {
                // pendingSwitch is no longer needed — multiSession plugin handles account
                // switching server-side without an OAuth redirect, so no pre-redirect flag.
                if (db.objectStoreNames.contains('pendingSwitch')) {
                    db.deleteObjectStore('pendingSwitch')
                }
            }
        },
    })
}
