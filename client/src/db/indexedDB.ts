import type { IDBPDatabase, IDBPTransaction, StoreNames } from 'idb';
import { openDB } from 'idb';
import type { MyDB, SyncOperation } from '../types/MyDB';

export async function openAppDB(): Promise<IDBPDatabase<MyDB>> {
    return openDB<MyDB>('gtd-app', 5, {
        async upgrade(db, oldVersion, _newVersion, tx) {
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
                // Old single-cursor-per-device store. Replaced in v4 by deviceMeta + syncCursors.
                // We still create it on the v1→v2 path so the v3→v4 migration below has data to read.
                if (!db.objectStoreNames.contains('deviceSyncState' as never)) {
                    db.createObjectStore('deviceSyncState' as never, { keyPath: '_id' });
                }

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
                await backfillSyncOperationUserIds(tx);
            }

            // Version 4: split the device-shared cursor into deviceMeta (singleton: deviceId +
            // flush lock) and syncCursors (per-user). A single shared cursor let one session's
            // pull advance past another session's boundary op — see the cross-account move bug.
            if (oldVersion < 4) {
                db.createObjectStore('deviceMeta', { keyPath: '_id' });
                db.createObjectStore('syncCursors', { keyPath: 'userId' });
                await migrateDeviceSyncStateToPerUserCursors(tx);
            }

            // Version 5: server entity shapes changed and both staging + production DBs were
            // wiped. Locally cached snapshots keyed by IDs the server no longer knows about would
            // linger forever (bootstrap puts new rows but never clears stale ones), so we drop
            // every cached entity + sync state and force a fresh bootstrap on next sign-in.
            // Keep `accounts` and `activeAccount` so the multi-account login list survives.
            // Awaited so it sequences strictly after the v4 cursor writes — otherwise a
            // concurrent fire-and-forget race could let the cursor land after the wipe.
            if (oldVersion < 5) {
                await wipeCachedEntitiesAndSyncState(tx);
            }
        },
    });
}

/**
 * v4 → v5 wipe: clears every store that holds server-replicated data or sync bookkeeping. The next
 * `bootstrapFromServer` call repopulates `items`/`routines`/`people`/`workContexts` from the server,
 * and `syncCursors`/`syncOperations` start empty as if this were a fresh device — except we keep
 * `deviceMeta` (which carries the stable `deviceId`) so push subscriptions and operation log purges
 * stay attached to the same identity. Any new server-replicated store added to `MyDB` must also be
 * added to the wipe list here.
 *
 * `deviceMeta.flushingTs` is also reset to null: a tab killed mid-flush against the dropped server
 * DB would otherwise leave a lingering lock until the 30s self-heal window elapses on next mount.
 */
async function wipeCachedEntitiesAndSyncState(tx: IDBPTransaction<MyDB, Array<StoreNames<MyDB>>, 'versionchange'>): Promise<void> {
    const stores = ['items', 'routines', 'people', 'workContexts', 'syncOperations', 'syncCursors'] as const satisfies ReadonlyArray<StoreNames<MyDB>>;
    await Promise.all(stores.map((name) => tx.objectStore(name).clear()));
    const meta = await tx.objectStore('deviceMeta').get('local');
    if (meta) {
        await tx.objectStore('deviceMeta').put({ ...meta, flushingTs: null });
    }
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

/**
 * Pre-v4 shape of the legacy deviceSyncState singleton — read inside the upgrade tx and split into
 * the two new stores. Declared locally because the schema-typed view of `deviceSyncState` has been
 * removed from `MyDB`; we read via the unknown-cast escape hatch the same way `backfillSyncOperationUserIds`
 * does.
 */
interface LegacyDeviceSyncState {
    _id: 'local';
    deviceId: string;
    lastSyncedTs: string;
    flushingTs: string | null;
}

/**
 * v3 → v4 split: copy `deviceId` + `flushingTs` to `deviceMeta`, copy `lastSyncedTs` to a single
 * `syncCursors` row keyed by the active account's userId. Other accounts (multi-session) start
 * fresh from epoch on their first pull — LWW makes the replay idempotent (same one-time spike as
 * the server-side migration).
 *
 * Then deletes the legacy `deviceSyncState` row to avoid stale reads if any code still touches it.
 * The store itself stays around (Chromium will not let us delete it inside a versionchange tx
 * unless we go through `db.deleteObjectStore`, which we skip — no readers remain anyway).
 */
async function migrateDeviceSyncStateToPerUserCursors(tx: IDBPTransaction<MyDB, Array<StoreNames<MyDB>>, 'versionchange'>): Promise<void> {
    // The legacy store is only present if the device upgraded through v2; brand-new v4 installs skip.
    const legacyStoreName = 'deviceSyncState' as unknown as StoreNames<MyDB>;
    if (!tx.db.objectStoreNames.contains(legacyStoreName)) {
        return;
    }
    const legacyStore = tx.objectStore(legacyStoreName);
    const raw = await (legacyStore as unknown as { get(key: 'local'): Promise<unknown> }).get('local');
    const legacy = raw as LegacyDeviceSyncState | undefined;
    if (!legacy) {
        return;
    }

    const metaStore = tx.objectStore('deviceMeta');
    await metaStore.put({ _id: 'local', deviceId: legacy.deviceId, flushingTs: legacy.flushingTs });

    // Map the single legacy cursor onto the active account's userId. If no active account exists
    // (rare — pre-login state with a populated cursor would be unusual), skip; the first pull
    // post-login will create the row at epoch.
    const activeStore = tx.objectStore('activeAccount');
    const active = await activeStore.get('active');
    if (active && legacy.lastSyncedTs) {
        const cursorsStore = tx.objectStore('syncCursors');
        await cursorsStore.put({ userId: active.userId, lastSyncedTs: legacy.lastSyncedTs });
    }

    await (legacyStore as unknown as { delete(key: 'local'): Promise<void> }).delete('local');
}
