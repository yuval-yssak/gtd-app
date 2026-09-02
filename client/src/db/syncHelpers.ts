import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import type { ServerOp } from '#api/syncClient';
import { fetchBootstrap, fetchSyncOps, pushSyncOps } from '#api/syncClient';
import { describeDevice } from '../lib/deviceLabel';
import { hasAtLeastOne } from '../lib/typeUtils';
import type {
    EntityType,
    MyDB,
    OpType,
    StoredEntity,
    StoredItem,
    StoredPerson,
    StoredReviewInbox,
    StoredRoutine,
    StoredRsvpOpPayload,
    StoredWorkContext,
    SyncOperation,
} from '../types/MyDB';
import { getActiveAccount } from './accountHelpers';
import { SYNC_APPLY_LOCK, withCrossContextLock } from './crossContextLock';
import { getOrCreateDeviceId, getSyncCursor, setSyncCursor } from './deviceId';
import { dispatchOpFlush } from './dispatchOpFlush';
import { bulkPutItems } from './itemHelpers';

interface BaseSyncOpParams {
    entityType: EntityType;
    entityId: string;
    /**
     * Owning user id. Optional — defaults to the active account so existing call sites that
     * always queue under the active session don't need to be updated. Pass explicitly when
     * the entity belongs to a non-active session (e.g. the future reassign flow).
     */
    userId?: string;
}

interface EntityWriteOpParams extends BaseSyncOpParams {
    opType: Exclude<OpType, 'rsvp'>;
    // Snapshot of the entity at the moment of the change; null for deletes.
    // Stored at queue-time so flush can send it directly without re-reading IndexedDB.
    snapshot: StoredEntity | null;
    /**
     * Optional GCal sidecar captured at edit time from SendUpdatesDialog. When present the value
     * is stored on the queued op and replayed through pushback when the queue flushes so the
     * organizer-notification decision survives offline → reconnect.
     */
    gcalMeta?: { sendUpdates: 'all' | 'none' };
}

interface RsvpOpParams extends BaseSyncOpParams {
    opType: 'rsvp';
    /** rsvp ops carry no entity snapshot — the rsvp sidecar drives the server-side replay. */
    snapshot: null;
    /**
     * RSVP payload — required when `opType === 'rsvp'`. Stored as a sidecar (not in `snapshot`)
     * so the server replay can drive `events.patch` without rebuilding entity state from the op log.
     */
    rsvp: StoredRsvpOpPayload;
}

/** Discriminated union on opType: rsvp ops must carry a `rsvp` payload; all others carry a snapshot. */
export type SyncOpParams = EntityWriteOpParams | RsvpOpParams;

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
    // Only entity-write ops carry gcalMeta — `mergeUpdateIntoCreate` is the create/update collapse path,
    // not the rsvp stream, so this branch never sees `opType: 'rsvp'`.
    const gcalMeta = op.opType !== 'rsvp' ? op.gcalMeta : undefined;
    await db.add('syncOperations', {
        userId,
        opType: 'create',
        entityType: op.entityType,
        entityId: op.entityId,
        queuedAt: queued.queuedAt,
        snapshot: op.snapshot,
        // gcalMeta is meaningful for calendar edits, not for the create itself, but if a caller
        // ever attaches it here we forward it onto the merged op so nothing is silently dropped.
        ...(gcalMeta ? { gcalMeta } : {}),
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
    // RSVP ops are their own coalescing stream — per plan they NEVER collapse with each other
    // (the organizer gets every state change so the email log matches what the user did) and they
    // do NOT interact with the create/update/delete stream for the same entity. Filter out rsvp
    // ops up-front so the entity-level collapse rules below don't see them.
    const existing = (await db.getAll('syncOperations')).filter((q) => q.entityId === entityId && q.opType !== 'rsvp');
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

    await db.add('syncOperations', {
        userId,
        opType,
        entityType,
        entityId,
        queuedAt: dayjs().toISOString(),
        snapshot,
        // Forward the GCal sidecars verbatim. Without this the destructure at the top silently
        // dropped sendUpdates / rsvp payloads, which was the bug Phase 1a's reviewer flagged.
        // The discriminated union ensures rsvp is present iff opType === 'rsvp', and gcalMeta is
        // only readable on the entity-write arm.
        ...(op.opType === 'rsvp' ? { rsvp: op.rsvp } : op.gcalMeta ? { gcalMeta: op.gcalMeta } : {}),
    });

    // Attempt an immediate flush. Safari and Firefox don't support the Background Sync API,
    // so without this the op would sit in IDB until the next mount or online event.
    // Fire-and-forget — errors are non-fatal; the online handler and mount effect will retry.
    // The dispatch routes through `syncSingleUser` whenever the queued op belongs to a different
    // account than the currently-active Better Auth session — without that pivot, the server's
    // misroute guard rejects the push with a 400 because session.user.id wouldn't match the
    // snapshot's userId. Same-account ops keep the lightweight path.
    void dispatchOpFlush(db, userId).catch((e) => console.warn('Failed to flush sync queue after adding op', e));
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

/**
 * Bootstrap without acquiring the session gate. Caller must already hold it. The IDB hydration runs
 * under the cross-context apply lock: the session gate is per-context, so without the lock a
 * Service Worker pull could interleave entity writes with this tab's snapshot hydration. The
 * network fetch stays OUTSIDE the lock — holding it across a slow request would wedge every other
 * context's sync for the duration (the exact failure mode the session gate's timeout exists for).
 */
export async function bootstrapFromServerUnguarded(db: IDBPDatabase<MyDB>, userId: string): Promise<void> {
    await assertActiveSessionMatches(db, userId, 'bootstrapFromServer');
    const deviceId = await getOrCreateDeviceId(db);

    // describeDevice gives the row a human-readable label for Settings → Connected devices.
    // navigator.userAgent exists in both window and Service Worker globals.
    const { items, routines, people, workContexts, reviewInboxes, serverTs, serverId } = await fetchBootstrap(deviceId, describeDevice(navigator.userAgent));

    const mappedItems = items.map((doc) => remapUser(doc) as unknown as StoredItem);
    const mappedRoutines = routines.map((doc) => remapUser(doc) as unknown as StoredRoutine);
    const mappedPeople = people.map((doc) => remapUser(doc) as unknown as StoredPerson);
    const mappedWorkContexts = workContexts.map((doc) => remapUser(doc) as unknown as StoredWorkContext);
    // `?? []` — a server deployed before the reviewInboxes entity omits the field entirely.
    const mappedReviewInboxes = (reviewInboxes ?? []).map((doc) => remapUser(doc) as unknown as StoredReviewInbox);

    await withCrossContextLock(SYNC_APPLY_LOCK, async () => {
        await bulkPutItems(db, mappedItems);

        const routinesTx = db.transaction('routines', 'readwrite');
        await Promise.all([...mappedRoutines.map((r) => routinesTx.store.put(r)), routinesTx.done]);

        const peopleTx = db.transaction('people', 'readwrite');
        await Promise.all([...mappedPeople.map((p) => peopleTx.store.put(p)), peopleTx.done]);

        const workContextsTx = db.transaction('workContexts', 'readwrite');
        await Promise.all([...mappedWorkContexts.map((wc) => workContextsTx.store.put(wc)), workContextsTx.done]);

        const reviewInboxesTx = db.transaction('reviewInboxes', 'readwrite');
        await Promise.all([...mappedReviewInboxes.map((ri) => reviewInboxesTx.store.put(ri)), reviewInboxesTx.done]);

        // Per-user compound cursor at (serverTs, serverId) — the snapshot already delivered the current
        // state, so incremental pull starts from here. The server holds the boundary a few seconds back
        // (serverId '' re-checks the boundary ms) so ops committing around the snapshot read are
        // re-delivered — idempotently — instead of skipped. `?? ''` is a type-level belt only (the
        // payload requires serverId); '' keeps the safe re-check-the-boundary-ms semantics if it ever
        // fires — the legacy MAX_OP_ID sentinel would skip that ms, the exact loss the holdback closes.
        await setSyncCursor(db, userId, serverTs, serverId ?? '');
    });
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
    // The IDB cursor `(ts, id)` doubles as `(since, sinceId)` (what ops to fetch) AND `(ackedTs,
    // ackedId)` (what we've durably persisted). They're equal in steady state — they only diverge
    // after a partial-apply failure where setSyncCursor ran but applyServerOp didn't (a state we
    // don't reach today; this protocol makes the contract explicit so we can split them later if
    // needed). Crucially we never advance the server's purge floor past what we've written to IDB.
    const cursor = await getSyncCursor(db, userId);
    const { ops, serverTs, serverId } = await fetchSyncOps(cursor.ts, cursor.id, cursor.ts, cursor.id, deviceId);

    console.log(
        `[debug-gcal-sync][client] doPull | userId=${userId} since=${cursor.ts}/${cursor.id} serverTs=${serverTs}/${serverId} opCount=${ops.length}`,
        ops.map((op) => `${op.opType}:${op.entityType}:${op.entityId}@${(op.snapshot as { updatedTs?: string } | null)?.updatedTs ?? 'n/a'}`),
    );

    // Cross-context lock around apply + ack: `pullInFlight`/`sessionGate` only dedupe within THIS
    // context, but every tab and the Service Worker share one IndexedDB. Two contexts pulling
    // different accounts can interleave applies for the same entityId (a cross-account reassign
    // emits delete+create under two users) — the delete's owner guard then reads a row the other
    // context is mid-replace, and the entity vanishes from IDB while the server stays correct.
    // The network fetch above deliberately stays OUTSIDE the lock so a slow request can't wedge
    // every other context's sync; the per-op transaction in `applyEntityOp` is the second layer
    // for browsers without Web Locks.
    await withCrossContextLock(SYNC_APPLY_LOCK, async () => {
        for (const op of ops) {
            await applyServerOp(db, userId, op);
        }
        await advanceSyncCursor(db, userId, serverTs, serverId ?? '');
    });
}

/**
 * Forward-only cursor write. Because the fetch runs outside the apply lock, another context may
 * have pulled the SAME user meanwhile and advanced the cursor past this response's `serverTs` —
 * re-applying that older op range is harmless (idempotent LWW snapshots), but blindly writing its
 * boundary would REWIND the cursor and re-fetch the range on every subsequent pull.
 * `serverId ?? ''` (caller) is a type-level belt only (the payload requires serverId); '' keeps
 * boundary-ms re-check semantics if it ever fires. Note `isForward === false` is also NORMAL on a
 * healthy pull: the server clamps its advertised boundary to the incoming cursor when the held-back
 * high-water sits at or below it, so an echoed-back cursor is simply a no-op here.
 */
async function advanceSyncCursor(db: IDBPDatabase<MyDB>, userId: string, serverTs: string, serverId: string): Promise<void> {
    const current = await getSyncCursor(db, userId);
    const isForward = serverTs > current.ts || (serverTs === current.ts && serverId > current.id);
    if (isForward) {
        await setSyncCursor(db, userId, serverTs, serverId);
    }
}

async function applyServerOp(db: IDBPDatabase<MyDB>, pullUserId: string, op: ServerOp): Promise<void> {
    // Exhaustive switch rather than a lookup map: pairing each entityType literal with its store
    // literal keeps `tx.store.put` typed to THAT store's value. A union-typed store name would
    // widen put to accept any entity into any store, silently allowing cross-store corruption from
    // a malformed wire op.
    switch (op.entityType) {
        case 'item':
            return applyEntityOp(db, 'items', pullUserId, op);
        case 'routine':
            return applyEntityOp(db, 'routines', pullUserId, op);
        case 'person':
            return applyEntityOp(db, 'people', pullUserId, op);
        case 'workContext':
            return applyEntityOp(db, 'workContexts', pullUserId, op);
        case 'reviewInbox':
            return applyEntityOp(db, 'reviewInboxes', pullUserId, op);
        default: {
            // Compile-time exhaustiveness: a new EntityType without a case here becomes a type
            // error. At runtime this branch IS reachable — a server deployed ahead of this client
            // build can emit entity types we don't know. Skip (never throw): a throw here aborts
            // doPull's apply loop before advanceSyncCursor, so the device would re-fetch the same
            // op and re-throw forever, halting sync for every entity type — not just the new one.
            const unreachable: never = op.entityType;
            console.warn(`[sync] skipping op for unknown entityType ${String(unreachable)} — client build predates it`);
            return;
        }
    }
}

/** The IDB stores that back syncable entities. */
type EntityStoreName = 'items' | 'routines' | 'people' | 'workContexts' | 'reviewInboxes';

/**
 * Ordinary clock skew between devices must never trip the poisoned-watermark escape below —
 * only a genuinely wrong timestamp (hours ahead, e.g. derived from a local date) qualifies.
 */
const POISONED_WATERMARK_TOLERANCE_MINUTES = 5;

/**
 * A local row stamped in the FUTURE rejects every legitimately-newer inbound edit until the wall
 * clock catches up — the poisoned-watermark incident (a calendar edit was silently dropped for
 * hours). The server now clamps future `updatedTs` on write, but its correcting echo is by
 * construction OLDER than the poisoned local row, so plain LWW can never repair the device that
 * created the poison. When the local watermark is impossibly far ahead of now, let the inbound
 * snapshot win regardless of LWW.
 */
function isPoisonedWatermark(existingUpdatedTs: string): boolean {
    return dayjs(existingUpdatedTs).isAfter(dayjs().add(POISONED_WATERMARK_TOLERANCE_MINUTES, 'minute'));
}

/**
 * The one LWW rule, named: the incoming snapshot wins when its `updatedTs` is newer than — or
 * TIED with — the stored row's (ISO-string compare). Tie → incoming wins, which converges across
 * devices because every device replays the same totally-ordered `(ts, _id)` op log. Mirror of the
 * server's `incomingWinsLww` in `api-server/src/lib/applyEntityOp.ts` — change both together.
 */
function incomingWinsLww(existingUpdatedTs: string, incomingUpdatedTs: string): boolean {
    return existingUpdatedTs <= incomingUpdatedTs;
}

/**
 * `pullUserId` is the user whose cursor is being advanced (i.e. the user the server scoped this
 * pull to). Used to scope deletes: a delete op only removes the local row when it still belongs
 * to that user. Without this guard, a cross-account reassign emits two ops with the same entityId
 * (delete under source, create under target). If the orchestrator pulls target before source, the
 * source's later delete blindly removes the post-move row by `_id` — the entity disappears.
 *
 * The whole read-check-write runs inside ONE readwrite transaction: IndexedDB serializes
 * overlapping readwrite transactions per store, so the owner/LWW check and the write it guards are
 * atomic even against another JS context (tab or Service Worker) applying ops or a local mutation
 * landing concurrently. Separate awaited get-then-put calls left a TOCTOU window that let a
 * reassign's delete op remove the freshly-reassigned row another context had just written.
 */
async function applyEntityOp<Name extends EntityStoreName>(db: IDBPDatabase<MyDB>, storeName: Name, pullUserId: string, op: ServerOp): Promise<void> {
    const tx = db.transaction(storeName, 'readwrite');
    const existing = (await tx.store.get(op.entityId)) as { updatedTs: string; userId: string } | undefined;
    if (op.opType === 'delete') {
        if (existing && existing.userId !== pullUserId) {
            console.log(
                `[debug-gcal-sync][client] applyEntityOp delete skipped — owner mismatch | type=${op.entityType} id=${op.entityId} pullUserId=${pullUserId} existingUserId=${existing.userId}`,
            );
            await tx.done;
            return;
        }
        await tx.store.delete(op.entityId);
        await tx.done;
        return;
    }
    if (!op.snapshot) {
        await tx.done;
        return;
    }
    // Wire-data trust boundary: the remapped server snapshot is cast to this store's value type —
    // the same trust the previous per-entity helpers placed in `e as StoredItem` etc.
    const incoming = remapUser(op.snapshot as Record<string, unknown> & { user: string }) as unknown as MyDB[Name]['value'] & { updatedTs: string };
    if (!existing || incomingWinsLww(existing.updatedTs, incoming.updatedTs) || isPoisonedWatermark(existing.updatedTs)) {
        await tx.store.put(incoming);
        console.log(
            `[debug-gcal-sync][client] applyEntityOp put | type=${op.entityType} id=${op.entityId} existingTs=${existing?.updatedTs ?? 'none'} incomingTs=${incoming.updatedTs}`,
        );
    } else {
        console.log(
            `[debug-gcal-sync][client] applyEntityOp skipped (LWW) | type=${op.entityType} id=${op.entityId} existingTs=${existing.updatedTs} incomingTs=${incoming.updatedTs}`,
        );
    }
    await tx.done;
}
