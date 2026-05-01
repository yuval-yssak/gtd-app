import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import type { ServerOp } from '#api/syncClient';
import { fetchBootstrap, fetchSyncOps, pushSyncOps } from '#api/syncClient';
import { hasAtLeastOne } from '../lib/typeUtils';
import type { EntityType, MyDB, OpType, StoredEntity, StoredItem, StoredPerson, StoredRoutine, StoredWorkContext, SyncOperation } from '../types/MyDB';
import { getActiveAccount } from './accountHelpers';
import { getLastSyncedTs, getOrCreateDeviceId, setLastSyncedTs } from './deviceId';
import { bulkPutItems, deleteItemById, putItem } from './itemHelpers';
import { deletePersonById, putPerson } from './personHelpers';
import { deleteRoutineById, putRoutine } from './routineHelpers';
import { deleteWorkContextById, putWorkContext } from './workContextHelpers';

export interface SyncOpParams {
    opType: OpType;
    entityType: EntityType;
    entityId: string;
    // Snapshot of the entity at the moment of the change; null for deletes.
    // Stored at queue-time so flush can send it directly without re-reading IndexedDB.
    snapshot: StoredEntity | null;
    /**
     * Owning user id. Optional — defaults to the active account so existing call sites that
     * always queue under the active session don't need to be updated. Pass explicitly when
     * the entity belongs to a non-active session (e.g. the future reassign flow).
     */
    userId?: string;
}

function remapUser<T extends Record<string, unknown>>(doc: T & { user: string }) {
    const { user, ...rest } = doc;
    return { ...rest, userId: user } as Omit<T, 'user'> & { userId: string };
}

// Update the snapshot on the pending 'create' rather than adding a second op.
// The single create will carry the latest state to the server.
async function mergeUpdateIntoCreate(db: IDBPDatabase<MyDB>, existing: SyncOperation[], op: SyncOpParams, userId: string) {
    // id is always present on records fetched from IDB; the type reflects pre-insert optionality
    const pendingCreates = existing.filter((q): q is SyncOperation & { id: number } => q.opType === 'create' && q.id !== undefined);
    // Invariant: at most one pending create per entity. Extra creates would be a queue
    // corruption bug — ignore them to avoid producing duplicate server creates.
    if (!hasAtLeastOne(pendingCreates)) return;
    const [queued] = pendingCreates;
    await db.delete('syncOperations', queued.id);
    await db.add('syncOperations', {
        userId,
        opType: 'create',
        entityType: op.entityType,
        entityId: op.entityId,
        queuedAt: queued.queuedAt,
        snapshot: op.snapshot,
    });
}

async function clearExistingOps(db: IDBPDatabase<MyDB>, existing: SyncOperation[]) {
    // id is always present on records fetched from IDB; the type reflects pre-insert optionality
    const withId = existing.filter((q): q is SyncOperation & { id: number } => q.id !== undefined);
    await Promise.all(withId.map((q) => db.delete('syncOperations', q.id)));
}

// Background Sync API isn't in the standard TS DOM lib — cast through unknown.
// Chrome/Edge only; Safari/Firefox fall back to the immediate flush in queueSyncOp.
function registerBackgroundSync(): void {
    if (!('serviceWorker' in navigator) || !('sync' in ServiceWorkerRegistration.prototype)) {
        return;
    }
    navigator.serviceWorker.ready
        .then((reg) => (reg as unknown as { sync: { register(tag: string): Promise<void> } }).sync.register('gtd-sync-queue'))
        .catch((e) => console.error('Failed to register background sync', e));
}

export async function queueSyncOp(db: IDBPDatabase<MyDB>, op: SyncOpParams): Promise<void> {
    const { opType, entityType, entityId, snapshot } = op;
    const userId = await resolveQueueUserId(db, op.userId);
    const existing = (await db.getAll('syncOperations')).filter((q) => q.entityId === entityId);
    const hasPendingCreate = existing.some((q) => q.opType === 'create');

    if (opType === 'update' && hasPendingCreate) {
        await mergeUpdateIntoCreate(db, existing, op, userId);
        return;
    }

    if (opType === 'delete') {
        // Collapse all prior ops. If a 'create' was pending, the item never reached the server — drop everything.
        await clearExistingOps(db, existing);
        if (hasPendingCreate) {
            return;
        }
    }

    await db.add('syncOperations', { userId, opType, entityType, entityId, queuedAt: dayjs().toISOString(), snapshot });

    // Attempt an immediate flush. Safari and Firefox don't support the Background Sync API,
    // so without this the op would sit in IDB until the next mount or online event.
    // Fire-and-forget — errors are non-fatal; the online handler and mount effect will retry.
    void flushSyncQueue(db).catch((e) => console.warn('Failed to flush sync queue after adding op', e));
    registerBackgroundSync();
}

/**
 * Resolves the userId to attach to a queued op. Caller-provided wins; otherwise we infer the
 * active account. Throws if neither is available — that would mean we'd write an op with no
 * owner, which the multi-account flush would silently drop.
 */
async function resolveQueueUserId(db: IDBPDatabase<MyDB>, explicitUserId: string | undefined): Promise<string> {
    if (explicitUserId) {
        return explicitUserId;
    }
    const active = await getActiveAccount(db);
    if (!active) {
        throw new Error('queueSyncOp: no active account and no explicit userId provided');
    }
    return active.id;
}

// Module-level guard so concurrent callers (queueSyncOp fire-and-forget, mount effect,
// online handler, service worker message) collapse into a single in-flight POST.
// Without this, two simultaneous flushes read the same queued ops and POST them twice,
// causing the server to send duplicate push notifications for the same change.
let flushInFlight: Promise<void> | null = null;

/** Wait for any in-flight sync flush to complete. Returns immediately if no flush is running. */
export function waitForPendingFlush(): Promise<void> {
    return flushInFlight ?? Promise.resolve();
}

export interface FlushOptions {
    /**
     * When set, only ops with `op.userId === userIdFilter` are flushed in this pass. Used by the
     * multi-account orchestrator to flush each user's queue under that user's active session,
     * keeping cross-account auth boundaries strict. Omitting flushes everything (back-compat).
     */
    userIdFilter?: string;
}

export function flushSyncQueue(db: IDBPDatabase<MyDB>, options: FlushOptions = {}): Promise<void> {
    if (flushInFlight) return flushInFlight;
    flushInFlight = doFlush(db, options).finally(() => {
        flushInFlight = null;
    });
    return flushInFlight;
}

// Cross-context flush lock: the main thread and Service Worker each have their own
// module-level flushInFlight guard, so they can race and POST the same ops twice.
// This IDB-based lock coordinates across JS contexts via the singleton deviceMeta record.
const FLUSH_LOCK_TTL_MS = 30_000;

type AcquireLockResult = 'acquired' | 'noDeviceState' | 'heldByOther';

// Uses a single readwrite transaction so the check-then-set is atomic — IDB serializes
// overlapping readwrite transactions on the same store, preventing TOCTOU races.
async function acquireFlushLock(db: IDBPDatabase<MyDB>): Promise<AcquireLockResult> {
    const tx = db.transaction('deviceMeta', 'readwrite');
    const store = tx.objectStore('deviceMeta');
    const state = await store.get('local');
    if (!state) {
        // No device meta yet — can't write a lock. No deviceId means pushSyncOps
        // would fail anyway, so skipping is safe.
        return 'noDeviceState';
    }
    if (state.flushingTs) {
        const elapsed = dayjs().diff(dayjs(state.flushingTs));
        if (elapsed < FLUSH_LOCK_TTL_MS) {
            return 'heldByOther';
        }
    }
    await store.put({ ...state, flushingTs: dayjs().toISOString() });
    await tx.done;
    return 'acquired';
}

async function releaseFlushLock(db: IDBPDatabase<MyDB>): Promise<void> {
    const tx = db.transaction('deviceMeta', 'readwrite');
    const store = tx.objectStore('deviceMeta');
    const state = await store.get('local');
    if (state) {
        await store.put({ ...state, flushingTs: null });
    }
    await tx.done;
}

async function doFlush(db: IDBPDatabase<MyDB>, options: FlushOptions): Promise<void> {
    const lockResult = await acquireFlushLock(db);
    if (lockResult === 'heldByOther') {
        console.log('[sync-flush] skipping — another context holds the flush lock');
        return;
    }
    if (lockResult === 'noDeviceState') {
        return;
    }
    try {
        // Loop until empty: a fire-and-forget flush from queueSyncOp may have started before
        // a subsequent mutation added more ops. Without the loop, those late-arriving ops
        // stay in IDB because the in-flight flush already read its batch before they existed.
        while (true) {
            const ops = await readQueuedOpsForFlush(db, options);
            if (!ops.length) {
                return;
            }

            console.log(
                `[sync-flush] pushing ${ops.length} ops to server (filter=${options.userIdFilter ?? 'all'})`,
                ops.map((op) => `${op.opType}:${op.entityType}:${op.entityId}`),
            );

            const deviceId = await getOrCreateDeviceId(db);
            await pushSyncOps(deviceId, ops);

            console.log(`[sync-flush] push succeeded, removed ${ops.length} ops from queue`);

            // Batch succeeded — remove all sent ops. If the request failed, they stay for retry.
            for (const op of ops) {
                if (op.id !== undefined) {
                    await db.delete('syncOperations', op.id);
                }
            }
        }
    } finally {
        await releaseFlushLock(db).catch((e) => console.warn('[sync-flush] failed to release flush lock', e));
    }
}

/**
 * Reads the queued ops that this flush pass should send. When `userIdFilter` is set we keep only
 * the ops owned by that user; the multi-account orchestrator pivots `multiSession.setActive`
 * between calls so the server always sees a session matching the ops it receives.
 */
async function readQueuedOpsForFlush(db: IDBPDatabase<MyDB>, options: FlushOptions): Promise<SyncOperation[]> {
    const all = await db.getAll('syncOperations');
    if (!options.userIdFilter) {
        return all;
    }
    return all.filter((op) => op.userId === options.userIdFilter);
}

/**
 * Throws if the active Better Auth session does not belong to `userId`. Per-user pulls and
 * bootstraps depend on the cookie pivot landing the request on the right server-side user — if
 * the active session is stale or belongs to a different account, the response would be attributed
 * to the wrong cursor and the wrong user's IDB rows. Used as a defensive guard inside `doPull` and
 * `bootstrapFromServer` so callers (orchestrator, SSE handler, devTools) cannot accidentally pull
 * for a user without first pivoting the session.
 */
async function assertActiveSessionMatches(db: IDBPDatabase<MyDB>, userId: string, callerName: string): Promise<void> {
    const active = await getActiveAccount(db);
    if (!active || active.id !== userId) {
        throw new Error(
            `${callerName}: active Better Auth session is ${active?.id ?? 'none'} but pull/bootstrap was requested for ${userId}. The orchestrator must pivot the active session before calling.`,
        );
    }
}

// bootstrapFromServer performs a full entity snapshot hydration for a (device, user) pair on its
// first sync. New (device, user) pairs cannot rely on /sync/pull because historical operations may
// have been purged before this user registered on this device. Bootstrap reads from the user's
// entity collections (permanent ground truth) and sets the per-user cursor to serverTs so
// incremental pull starts from now, not epoch.
export function bootstrapFromServer(db: IDBPDatabase<MyDB>, userId: string): Promise<void> {
    return withSessionGate(() => bootstrapFromServerUnguarded(db, userId));
}

/** Bootstrap without acquiring the session gate. Caller must already hold it. */
export async function bootstrapFromServerUnguarded(db: IDBPDatabase<MyDB>, userId: string): Promise<void> {
    await assertActiveSessionMatches(db, userId, 'bootstrapFromServer');
    const deviceId = await getOrCreateDeviceId(db);

    const { items, routines, people, workContexts, serverTs } = await fetchBootstrap(deviceId);

    const mappedItems = items.map((doc) => remapUser(doc) as unknown as StoredItem);
    const mappedRoutines = routines.map((doc) => remapUser(doc) as unknown as StoredRoutine);
    const mappedPeople = people.map((doc) => remapUser(doc) as unknown as StoredPerson);
    const mappedWorkContexts = workContexts.map((doc) => remapUser(doc) as unknown as StoredWorkContext);

    await bulkPutItems(db, mappedItems);

    const routinesTx = db.transaction('routines', 'readwrite');
    await Promise.all([...mappedRoutines.map((r) => routinesTx.store.put(r)), routinesTx.done]);

    const peopleTx = db.transaction('people', 'readwrite');
    await Promise.all([...mappedPeople.map((p) => peopleTx.store.put(p)), peopleTx.done]);

    const workContextsTx = db.transaction('workContexts', 'readwrite');
    await Promise.all([...mappedWorkContexts.map((wc) => workContextsTx.store.put(wc)), workContextsTx.done]);

    // Per-user cursor at serverTs — skips replaying historical ops because bootstrap already
    // delivered the current snapshot; incremental pull takes over from here.
    await setLastSyncedTs(db, userId, serverTs);
}

// Active-session-dependent operations (pulls, orchestrator passes) all read or mutate the global
// Better Auth session cookie. We serialize them through a single mutex so two parallel pulls for
// different users can't observe one user's session pivot mid-fetch and attribute that response to
// the wrong user's cursor (the failure mode H1/M1 in the per-user-cursor review). Per-user dedup
// (an SSE event arriving while a SW-push pull is in flight for the same user) is layered on top
// via `pullInFlight`.
let sessionGate: Promise<void> = Promise.resolve();

/**
 * Hard deadline for any single gate task. A stalled fetch (e.g. a session pivot retrying behind
 * a slow Google Calendar API call) used to wedge the gate forever, blocking every queued caller —
 * surfaced as the EditItemDialog hang on cross-account reassign. After this deadline the gate is
 * released so queued tasks proceed; the original task keeps running and its eventual settlement
 * is logged but does not block the caller chain.
 *
 * Exposed for tests (via `setSessionGateTimeoutMs`) so timing-dependent specs can run fast.
 */
let sessionGateTimeoutMs = 10_000;

/** Test-only: override the gate timeout. Restored to the default at the end of each test. */
export function setSessionGateTimeoutMs(ms: number): void {
    sessionGateTimeoutMs = ms;
}

/** Run `task` after any in-flight session-dependent op completes. Returns the task's result. */
export function withSessionGate<T>(task: () => Promise<T>): Promise<T> {
    const previous = sessionGate;
    let release!: () => void;
    sessionGate = new Promise<void>((resolve) => {
        release = resolve;
    });
    // Hard timeout to release the gate even if `task` never settles. Without this, one stuck
    // task wedges every queued caller until page refresh.
    const timeoutMs = sessionGateTimeoutMs;
    const result = previous.then(task);
    let released = false;
    const releaseOnce = () => {
        if (released) {
            return;
        }
        released = true;
        release();
    };
    const timer = setTimeout(() => {
        if (!released) {
            console.warn(`[sync] session gate task exceeded ${timeoutMs}ms — releasing gate; task continues in background`);
        }
        releaseOnce();
    }, timeoutMs);
    // When the task settles (either before or after the timeout) clear the timer and ensure
    // release fires exactly once. The trailing `.catch(() => {})` swallows the rejection on
    // this internal-only chain — the caller's rejection handler runs on `result`, not here.
    result
        .finally(() => {
            clearTimeout(timer);
            releaseOnce();
        })
        .catch(() => {});
    return result;
}

const pullInFlight = new Map<string, Promise<void>>();

/**
 * Per-user pull that acquires the session gate. Use from any caller outside the orchestrator
 * (SSE handler, devTools). The orchestrator calls `pullFromServerUnguarded` to avoid recursing
 * into the gate it already holds.
 *
 * Same-user dedup happens before the gate — two SSE events arriving for the same user collapse
 * into one queue entry rather than two sequential gate acquisitions.
 */
export function pullFromServer(db: IDBPDatabase<MyDB>, userId: string): Promise<void> {
    const existing = pullInFlight.get(userId);
    if (existing) return existing;
    const promise = withSessionGate(() => doPull(db, userId)).finally(() => pullInFlight.delete(userId));
    pullInFlight.set(userId, promise);
    return promise;
}

/**
 * Per-user pull WITHOUT acquiring the session gate. Caller must already hold it. Same-user dedup
 * still applies — the orchestrator serializes its own loop so this rarely matters, but defending
 * against re-entrancy is cheap.
 */
export function pullFromServerUnguarded(db: IDBPDatabase<MyDB>, userId: string): Promise<void> {
    const existing = pullInFlight.get(userId);
    if (existing) return existing;
    const promise = doPull(db, userId).finally(() => pullInFlight.delete(userId));
    pullInFlight.set(userId, promise);
    return promise;
}

/**
 * Fetches and applies server operations for a single user from the sync endpoint.
 * Must not run concurrently for the same userId — call through `pullFromServer()` which provides a guard.
 * Parallel runs for the same user can race on `setLastSyncedTs` and silently drop ops from one run.
 *
 * The `userId` argument names which per-user cursor to read/write — it must match the user whose
 * Better Auth session is *currently active*, since the server scopes the pull response to
 * `session.user.id`. Callers using `syncAllLoggedInUsers` pivot the active session per-pass.
 */
async function doPull(db: IDBPDatabase<MyDB>, userId: string): Promise<void> {
    await assertActiveSessionMatches(db, userId, 'doPull');
    const deviceId = await getOrCreateDeviceId(db);
    const since = await getLastSyncedTs(db, userId);
    const { ops, serverTs } = await fetchSyncOps(since, deviceId);

    console.log(
        `[debug-gcal-sync][client] doPull | userId=${userId} since=${since} serverTs=${serverTs} opCount=${ops.length}`,
        ops.map((op) => `${op.opType}:${op.entityType}:${op.entityId}@${(op.snapshot as { updatedTs?: string } | null)?.updatedTs ?? 'n/a'}`),
    );

    for (const op of ops) {
        await applyServerOp(db, userId, op);
    }

    await setLastSyncedTs(db, userId, serverTs);
}

// Handlers for each entity type used by applyEntityOp to stay DRY across entity types.
// Each entry provides the three DB operations needed to apply a server op.
interface EntityApplyHandlers {
    getExisting: (id: string) => Promise<{ updatedTs: string; userId: string } | undefined>;
    put: (entity: unknown) => Promise<void>;
    remove: (id: string) => Promise<void>;
}

function buildEntityHandlers(db: IDBPDatabase<MyDB>): Record<EntityType, EntityApplyHandlers> {
    return {
        item: {
            getExisting: (id) => db.get('items', id),
            put: (e) => putItem(db, e as StoredItem),
            remove: (id) => deleteItemById(db, id),
        },
        routine: {
            getExisting: (id) => db.get('routines', id),
            put: (e) => putRoutine(db, e as StoredRoutine),
            remove: (id) => deleteRoutineById(db, id),
        },
        person: {
            getExisting: (id) => db.get('people', id),
            put: (e) => putPerson(db, e as StoredPerson),
            remove: (id) => deletePersonById(db, id),
        },
        workContext: {
            getExisting: (id) => db.get('workContexts', id),
            put: (e) => putWorkContext(db, e as StoredWorkContext),
            remove: (id) => deleteWorkContextById(db, id),
        },
    };
}

async function applyServerOp(db: IDBPDatabase<MyDB>, pullUserId: string, op: ServerOp): Promise<void> {
    const handlers = buildEntityHandlers(db);
    await applyEntityOp(pullUserId, op, handlers[op.entityType]);
}

/**
 * `pullUserId` is the user whose cursor is being advanced (i.e. the user the server scoped this
 * pull to). Used to scope deletes: a delete op only removes the local row when it still belongs
 * to that user. Without this guard, a cross-account reassign emits two ops with the same entityId
 * (delete under source, create under target). If the orchestrator pulls target before source, the
 * source's later delete blindly removes the post-move row by `_id` — the entity disappears.
 */
async function applyEntityOp(pullUserId: string, op: ServerOp, handlers: EntityApplyHandlers): Promise<void> {
    if (op.opType === 'delete') {
        const existing = await handlers.getExisting(op.entityId);
        if (existing && existing.userId !== pullUserId) {
            console.log(
                `[debug-gcal-sync][client] applyEntityOp delete skipped — owner mismatch | type=${op.entityType} id=${op.entityId} pullUserId=${pullUserId} existingUserId=${existing.userId}`,
            );
            return;
        }
        await handlers.remove(op.entityId);
        return;
    }
    if (!op.snapshot) {
        return;
    }
    // Cast to the minimal shape needed here (updatedTs for conflict resolution);
    // handlers.put receives the full object as unknown and re-casts to the concrete type.
    const incoming = remapUser(op.snapshot as Record<string, unknown> & { user: string }) as unknown as { updatedTs: string };
    const existing = await handlers.getExisting(op.entityId);
    if (!existing || existing.updatedTs <= incoming.updatedTs) {
        await handlers.put(incoming);
        console.log(
            `[debug-gcal-sync][client] applyEntityOp put | type=${op.entityType} id=${op.entityId} existingTs=${existing?.updatedTs ?? 'none'} incomingTs=${incoming.updatedTs}`,
        );
    } else {
        console.log(
            `[debug-gcal-sync][client] applyEntityOp skipped (LWW) | type=${op.entityType} id=${op.entityId} existingTs=${existing.updatedTs} incomingTs=${incoming.updatedTs}`,
        );
    }
}
