import { forceCloseDatabase, IDBFactory } from 'fake-indexeddb';
import type { IDBPDatabase } from 'idb';
import { unwrap } from 'idb';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openAppDB } from '../db/indexedDB';
import { selfHealingConnection, simulateConnectionLoss } from '../db/selfHealingDB';
import type { MyDB, StoredAccount, SyncOperation } from '../types/MyDB';

// WebKit's own wording when its IndexedDB server has dropped the transaction under a live
// connection (seen in the installed iOS PWA after it comes back from the background).
const WEBKIT_LOST_TRANSACTION = 'Attempt to get all index records from database without an in-progress transaction';

type Reopen = () => Promise<IDBPDatabase<MyDB>>;

function account(id: string): StoredAccount {
    return { id, email: `${id}@example.com`, name: id, image: null, provider: 'google', addedAt: 1 };
}

function queuedOp(entityId: string): SyncOperation {
    return { userId: 'user-A', entityType: 'item', entityId, opType: 'create', queuedAt: '2026-01-01T00:00:00.000Z', snapshot: null };
}

function webKitLostTransactionError() {
    return new DOMException(WEBKIT_LOST_TRANSACTION, 'UnknownError');
}

/** A real connection with some members replaced, standing in for WebKit's failures. */
function withMembers(connection: IDBPDatabase<MyDB>, overrides: Record<string, (...args: unknown[]) => unknown>): IDBPDatabase<MyDB> {
    return new Proxy(connection, {
        get(target, prop) {
            if (typeof prop === 'string' && prop in overrides) {
                return overrides[prop];
            }
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

/** A real connection whose `getAllFromIndex` fails the way WebKit does, `failures` times. */
function readsFailingLikeWebKit(connection: IDBPDatabase<MyDB>, failures: number) {
    // let: counts down across calls
    let remaining = failures;
    return withMembers(connection, {
        getAllFromIndex: (...args) => {
            if (remaining > 0) {
                remaining -= 1;
                return Promise.reject(webKitLostTransactionError());
            }
            return Reflect.apply(connection.getAllFromIndex, connection, args);
        },
    });
}

/** A connection whose transactions open fine, then fail their first request the way WebKit does. */
function transactionsFailingLikeWebKit(connection: IDBPDatabase<MyDB>) {
    return withMembers(connection, {
        transaction: () => ({ store: { put: () => Promise.reject(webKitLostTransactionError()) }, done: Promise.reject(webKitLostTransactionError()) }),
    });
}

/** fake-indexeddb's forced close, the one closure that fires `close` (as a browser dropping the database does). */
function forceCloseBrowserSide(connection: IDBPDatabase<MyDB>) {
    // Reflect.apply: the package types the parameter as the FDBDatabase constructor, not an instance.
    Reflect.apply(forceCloseDatabase, undefined, [unwrap(connection)]);
}

const openedConnections: IDBPDatabase<MyDB>[] = [];

async function trackedOpen() {
    const connection = await openAppDB();
    openedConnections.push(connection);
    return connection;
}

/** The self-healing db over `first` (a fresh connection by default), and the spy standing in for its reopen. */
async function healingDB(reopen: Reopen = trackedOpen, first?: IDBPDatabase<MyDB>) {
    const reopenSpy = vi.fn(reopen);
    const db = selfHealingConnection(first ?? (await trackedOpen()), reopenSpy);
    return { db, reopenSpy };
}

/** Waits for the handle's single reopen and returns the connection it opened. */
async function reopenedConnection(reopenSpy: Mock<Reopen>) {
    await vi.waitFor(() => expect(reopenSpy).toHaveBeenCalledTimes(1));
    const [result] = reopenSpy.mock.results;
    if (!result) {
        throw new Error('expected one reopen');
    }
    return result.value;
}

/** A reopen that waits until the test resolves it, to hold the handle mid-reopen. */
function heldReopen() {
    // let: the resolver escapes the executor (the client's lib target predates Promise.withResolvers)
    let finishWith: (connection: IDBPDatabase<MyDB>) => void = () => {};
    const opening = new Promise<IDBPDatabase<MyDB>>((resolve) => {
        finishWith = resolve;
    });
    return { reopen: () => opening, finishWith: (connection: IDBPDatabase<MyDB>) => finishWith(connection) };
}

beforeEach(() => {
    // Each test gets an isolated IDBFactory, the same swap indexedDBMigration.test.ts uses.
    globalThis.indexedDB = new IDBFactory();
});

afterEach(() => {
    openedConnections.splice(0).forEach((connection) => {
        connection.close();
    });
});

describe('selfHealingConnection — reads', () => {
    it('reopens and answers a read after the connection is lost', async () => {
        const { db, reopenSpy } = await healingDB();
        await db.put('accounts', account('a'));

        simulateConnectionLoss(db);

        expect(await db.getAllFromIndex('accounts', 'email')).toEqual([account('a')]);
        expect(reopenSpy).toHaveBeenCalledTimes(1);
    });

    it('retries a read that WebKit failed with "without an in-progress transaction"', async () => {
        const first = await trackedOpen();
        await first.put('accounts', account('a'));
        const { db, reopenSpy } = await healingDB(trackedOpen, readsFailingLikeWebKit(first, 1));

        expect(await db.getAllFromIndex('accounts', 'email')).toEqual([account('a')]);
        expect(reopenSpy).toHaveBeenCalledTimes(1);
    });

    it('gives up after one retry, so a broken database still surfaces its error', async () => {
        const alwaysFailing = async () => readsFailingLikeWebKit(await trackedOpen(), Number.POSITIVE_INFINITY);
        const { db, reopenSpy } = await healingDB(alwaysFailing, await alwaysFailing());

        await expect(db.getAllFromIndex('accounts', 'email')).rejects.toThrow(WEBKIT_LOST_TRANSACTION);
        expect(reopenSpy).toHaveBeenCalledTimes(1);
    });

    it('shares one reopen between reads that fail at the same time', async () => {
        const { db, reopenSpy } = await healingDB();

        simulateConnectionLoss(db);

        await Promise.all([db.getAll('accounts'), db.getAllFromIndex('accounts', 'email'), db.count('accounts')]);
        expect(reopenSpy).toHaveBeenCalledTimes(1);
    });

    it('tries to reopen again on a later read when a reopen failed', async () => {
        const reopen = vi.fn<Reopen>().mockRejectedValueOnce(new Error('open failed')).mockImplementation(trackedOpen);
        const { db } = await healingDB(reopen);

        simulateConnectionLoss(db);

        await expect(db.getAll('accounts')).rejects.toThrow('open failed');
        expect(await db.getAll('accounts')).toEqual([]);
        expect(reopen).toHaveBeenCalledTimes(2);
    });
});

describe('selfHealingConnection — writes', () => {
    it('lands a write made after the connection is lost', async () => {
        const { db } = await healingDB();

        simulateConnectionLoss(db);
        await db.put('accounts', account('b'));

        const independent = await trackedOpen();
        expect(await independent.get('accounts', 'b')).toEqual(account('b'));
    });

    it('queues exactly one sync op when the add that discovered the loss is retried', async () => {
        const { db } = await healingDB();

        simulateConnectionLoss(db);
        await db.add('syncOperations', queuedOp('item-1'));

        const independent = await trackedOpen();
        expect((await independent.getAll('syncOperations')).map((op) => op.entityId)).toEqual(['item-1']);
    });

    it('does not retry or reopen on an ordinary failure such as a duplicate key', async () => {
        const { db, reopenSpy } = await healingDB();
        await db.add('accounts', account('a'));

        await expect(db.add('accounts', account('a'))).rejects.toMatchObject({ name: 'ConstraintError' });
        expect(reopenSpy).not.toHaveBeenCalled();
    });
});

describe('selfHealingConnection — explicit transactions', () => {
    it('replaces a connection the browser closed before the next transaction', async () => {
        const first = await trackedOpen();
        const { db, reopenSpy } = await healingDB(trackedOpen, first);

        forceCloseBrowserSide(first);
        await reopenedConnection(reopenSpy);

        const tx = db.transaction('accounts', 'readwrite');
        await Promise.all([tx.store.put(account('c')), tx.done]);
        expect(await db.get('accounts', 'c')).toEqual(account('c'));
    });

    it('fails one transaction on a silently lost connection, then serves the next from a new one', async () => {
        const { db, reopenSpy } = await healingDB();

        simulateConnectionLoss(db);

        // A transaction is created synchronously, so the one that discovers the loss cannot wait
        // for the reopen — it throws, and starts the reopen for whoever comes next.
        expect(() => db.transaction('accounts')).toThrow();
        await reopenedConnection(reopenSpy);
        expect(await db.transaction('accounts').store.getAll()).toEqual([]);
    });

    it('reopens after a request inside an open transaction fails the way WebKit does', async () => {
        const { db, reopenSpy } = await healingDB(trackedOpen, transactionsFailingLikeWebKit(await trackedOpen()));

        const failing = db.transaction('accounts', 'readwrite');
        await expect(Promise.all([failing.store.put(account('d')), failing.done])).rejects.toThrow(WEBKIT_LOST_TRANSACTION);
        await reopenedConnection(reopenSpy);

        const tx = db.transaction('accounts', 'readwrite');
        await Promise.all([tx.store.put(account('d')), tx.done]);
        expect(await db.get('accounts', 'd')).toEqual(account('d'));
    });
});

describe('selfHealingConnection — the app closing it', () => {
    it('stays closed after close(), without reopening', async () => {
        const { db, reopenSpy } = await healingDB();

        db.close();

        await expect(db.getAll('accounts')).rejects.toMatchObject({ name: 'InvalidStateError' });
        expect(reopenSpy).not.toHaveBeenCalled();
    });

    it('closes a connection that finishes reopening after the app closed the handle', async () => {
        const { reopen, finishWith } = heldReopen();
        const { db, reopenSpy } = await healingDB(reopen);
        simulateConnectionLoss(db);
        const reading = db.getAll('accounts');
        await vi.waitFor(() => expect(reopenSpy).toHaveBeenCalledTimes(1));

        db.close();
        const lateConnection = await trackedOpen();
        finishWith(lateConnection);

        await expect(reading).rejects.toMatchObject({ name: 'InvalidStateError' });
        // A transaction on a closed connection throws synchronously — proof it was released.
        expect(() => lateConnection.transaction('accounts')).toThrow();
    });
});

describe('selfHealingConnection — pass-through members', () => {
    it('reads schema facts such as the version from the live connection', async () => {
        const { db } = await healingDB();
        const independent = await trackedOpen();

        expect(db.version).toBe(independent.version);
        expect(db.objectStoreNames.contains('accounts')).toBe(true);
    });
});
