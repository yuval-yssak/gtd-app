import type { DBSchema, IDBPDatabase } from 'idb';

// Safari — the installed iOS PWA above all — loses IndexedDB connections it suspended in the
// background. The page keeps the stale connection, and its next read fails with
// UnknownError "Attempt to get all index records from database without an in-progress
// transaction" (or InvalidStateError once the connection is marked closed), which the error
// boundary shows as "Something went wrong". A fresh connection works, so this module keeps one.

/** Error names that mean the connection is gone, not that the request was wrong. */
// InvalidStateError is also what transaction() throws during a versionchange; there the reopen
// simply fails with VersionError before the blocking handler's reload, so it needs no exception.
const CONNECTION_LOST_ERRORS = new Set(['UnknownError', 'InvalidStateError', 'TransactionInactiveError']);

/** idb's one-request shortcuts: each runs in its own transaction, so a failed one can run again whole. */
const ONE_TRANSACTION_SHORTCUTS = new Set<PropertyKey>([
    'get',
    'getKey',
    'getAll',
    'getAllKeys',
    'count',
    'put',
    'add',
    'delete',
    'clear',
    'getFromIndex',
    'getKeyFromIndex',
    'getAllFromIndex',
    'getAllKeysFromIndex',
    'countFromIndex',
]);

interface ConnectionState<DB extends DBSchema> {
    current: IDBPDatabase<DB>;
    reopening: Promise<IDBPDatabase<DB>> | null;
    isClosedByApp: boolean;
    reopen: () => Promise<IDBPDatabase<DB>>;
}

const statesByHandle = new WeakMap<object, { current: { close(): void } }>();

/**
 * A database handle that outlives its connection: when the browser drops the connection, the
 * next request reopens through `reopen` and a one-request shortcut that hit the loss runs once
 * more on the new connection. Explicit transactions are created synchronously, so the one that
 * discovers a loss still throws; it starts the reopen for the next caller.
 */
export function selfHealingConnection<DB extends DBSchema>(first: IDBPDatabase<DB>, reopen: () => Promise<IDBPDatabase<DB>>) {
    const state: ConnectionState<DB> = { current: first, reopening: null, isClosedByApp: false, reopen };
    watchForForcedClose(state, first);
    const handle = new Proxy(first, { get: (_target, prop) => resolveMember(state, prop) });
    statesByHandle.set(handle, state);
    return handle;
}

/** Dev/e2e harness: closes the live connection behind the handle's back, the way Safari drops it. */
export function simulateConnectionLoss(handle: object) {
    statesByHandle.get(handle)?.current.close();
}

function resolveMember<DB extends DBSchema>(state: ConnectionState<DB>, prop: PropertyKey): unknown {
    if (prop === 'close') {
        return () => closeByApp(state);
    }
    if (prop === 'transaction') {
        return (...args: unknown[]) => openTransaction(state, args);
    }
    if (ONE_TRANSACTION_SHORTCUTS.has(prop)) {
        return (...args: unknown[]) => runWithOneRetry(state, (connection) => callMember(connection, prop, args));
    }
    const value: unknown = Reflect.get(state.current, prop, state.current);
    // idb's members unwrap `this`, so they must be called on the connection, not on this proxy.
    return typeof value === 'function' ? value.bind(state.current) : value;
}

function callMember(connection: object, prop: PropertyKey, args: unknown[]): unknown {
    const member: unknown = Reflect.get(connection, prop, connection);
    if (typeof member !== 'function') {
        throw new TypeError(`IndexedDB connection has no method ${String(prop)}`);
    }
    return Reflect.apply(member, connection, args);
}

async function runWithOneRetry<DB extends DBSchema>(state: ConnectionState<DB>, request: (connection: IDBPDatabase<DB>) => unknown) {
    const attempted = state.current;
    try {
        return await request(attempted);
    } catch (err) {
        if (!shouldReconnect(state, err)) {
            throw err;
        }
        return request(await replaceConnection(state, attempted, err));
    }
}

function openTransaction<DB extends DBSchema>(state: ConnectionState<DB>, args: unknown[]) {
    const attempted = state.current;
    try {
        const tx = callMember(attempted, 'transaction', args);
        healWhenTransactionLosesConnection(state, attempted, tx);
        return tx;
    } catch (err) {
        if (shouldReconnect(state, err)) {
            replaceInBackground(state, attempted, err);
        }
        throw err;
    }
}

// WebKit reports a dropped connection asynchronously too: a request inside a transaction that
// opened fine fails with UnknownError. The caller still gets that rejection; this only starts the
// reopen, so the next transaction does not land on the same dead connection.
function healWhenTransactionLosesConnection<DB extends DBSchema>(state: ConnectionState<DB>, attempted: IDBPDatabase<DB>, tx: unknown) {
    if (!hasDonePromise(tx)) {
        return;
    }
    tx.done.catch((err: unknown) => {
        if (shouldReconnect(state, err)) {
            replaceInBackground(state, attempted, err);
        }
    });
}

function hasDonePromise(tx: unknown): tx is { done: Promise<unknown> } {
    return typeof tx === 'object' && tx !== null && 'done' in tx && tx.done instanceof Promise;
}

function shouldReconnect<DB extends DBSchema>(state: ConnectionState<DB>, err: unknown) {
    return !state.isClosedByApp && isConnectionLostError(err);
}

function isConnectionLostError(err: unknown) {
    return typeof err === 'object' && err !== null && 'name' in err && typeof err.name === 'string' && CONNECTION_LOST_ERRORS.has(err.name);
}

/** One reopen per lost connection, however many requests discover the loss at once. */
function replaceConnection<DB extends DBSchema>(state: ConnectionState<DB>, lost: IDBPDatabase<DB>, reason: unknown) {
    if (state.current !== lost) {
        return Promise.resolve(state.current);
    }
    if (!state.reopening) {
        console.info('[gtd-db] connection lost; reopening', { reason: describeError(reason) });
        state.reopening = state
            .reopen()
            .then((next) => adoptConnection(state, lost, next))
            // Cleared on failure too, so a later request can try again instead of reusing the rejection.
            .finally(() => {
                state.reopening = null;
            });
    }
    return state.reopening;
}

function adoptConnection<DB extends DBSchema>(state: ConnectionState<DB>, lost: IDBPDatabase<DB>, next: IDBPDatabase<DB>) {
    // The app closed the handle while the reopen was in flight: an orphaned open connection would
    // block every later schema upgrade, so release it and stay closed.
    if (state.isClosedByApp) {
        next.close();
        throw new DOMException('The database connection is closing.', 'InvalidStateError');
    }
    state.current = next;
    watchForForcedClose(state, next);
    lost.close();
    return next;
}

function replaceInBackground<DB extends DBSchema>(state: ConnectionState<DB>, lost: IDBPDatabase<DB>, reason: unknown) {
    replaceConnection(state, lost, reason).catch((err: unknown) => {
        console.error('[gtd-db] reopening the database failed', { err });
    });
}

// The browser fires `close` only when it drops the connection itself; our own close() never does.
function watchForForcedClose<DB extends DBSchema>(state: ConnectionState<DB>, connection: IDBPDatabase<DB>) {
    connection.addEventListener('close', () => {
        if (!state.isClosedByApp) {
            replaceInBackground(state, connection, 'close event');
        }
    });
}

function closeByApp<DB extends DBSchema>(state: ConnectionState<DB>) {
    state.isClosedByApp = true;
    state.current.close();
}

function describeError(reason: unknown) {
    return reason instanceof Error || reason instanceof DOMException ? `${reason.name}: ${reason.message}` : String(reason);
}
