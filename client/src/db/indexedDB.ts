import type { IDBPDatabase, IDBPTransaction, StoreNames } from 'idb';
import { openDB } from 'idb';
import type { MyDB, SyncOperation } from '../types/MyDB';

export async function openAppDB(): Promise<IDBPDatabase<MyDB>> {
    return openDB<MyDB>('gtd-app', 3, {
        upgrade(db, oldVersion, _newVersion, tx) {
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

            // Version 3: multi-account sync — every queued sync op now carries `userId` so
            // `flushSyncQueue` can fan out per logged-in account. Backfill existing rows with the
            // currently-active account id so we don't drop ops queued before the bump (a clear-on-
            // upgrade strategy would silently swallow offline-queued mutations from the user's
            // pre-upgrade session).
            if (oldVersion < 3) {
                void backfillSyncOperationUserIds(tx);
            }
        },
    });
}

/**
 * Reads the active account id from the (already-existing) `activeAccount` store and copies it onto
 * every queued `syncOperation` row that lacks one. Runs inside the upgrade transaction so all writes
 * land before any application code reads from the migrated store.
 *
 * The function intentionally degrades to a no-op if no active account exists yet — that only happens
 * on a brand-new install where the queue is empty anyway.
 */
async function backfillSyncOperationUserIds(tx: IDBPTransaction<MyDB, Array<StoreNames<MyDB>>, 'versionchange'>): Promise<void> {
    const activeStore = tx.objectStore('activeAccount');
    const active = await activeStore.get('active');
    if (!active) {
        return;
    }
    const opsStore = tx.objectStore('syncOperations');
    let cursor = await opsStore.openCursor();
    while (cursor) {
        // Pre-bump rows lack `userId`; the property is read via an `unknown` cast because the
        // post-bump type marks it required. We don't widen the schema type itself — that would
        // ripple userId-optional through every read site for the sake of a one-shot migration.
        const legacyValue = cursor.value as unknown as Partial<SyncOperation>;
        if (!legacyValue.userId) {
            await cursor.update({ ...cursor.value, userId: active.userId });
        }
        cursor = await cursor.continue();
    }
}
