import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import type { OpCursor, PullPayload, ServerOp } from '#api/syncClient';
import {
    BootstrapRequiredError,
    fetchBootstrap,
    fetchSyncOps,
    PUSH_BATCH_MAX,
    PUSH_TIMEOUT_MS,
    pushSyncOps,
    SessionUserMismatchError,
    SyncAuthError,
} from '#api/syncClient';
import type { ServerItemBriefSnapshot } from '../api/briefApi';
import type { ServerClaudeAskSnapshot } from '../api/claudeRoutineApi';
import { describeDevice } from '../lib/deviceLabel';
import { forgetNetworkVerificationFor, markVerifiedWithNetwork, notifySyncQueueChanged } from '../lib/syncFreshness';
import { hasAtLeastOne } from '../lib/typeUtils';
import type {
    EntityType,
    GCalOpMeta,
    MyDB,
    OpType,
    StoredClaudeAsk,
    StoredEntity,
    StoredItem,
    StoredItemBrief,
    StoredPerson,
    StoredReviewInbox,
    StoredRoutine,
    StoredRsvpOpPayload,
    StoredWorkContext,
    SyncOperation,
} from '../types/MyDB';
import { getActiveAccount, getIntendedActiveAccount, isAccountOnDevice } from './accountHelpers';
import { mergeServerOwnedCalendarFields } from './calendarLinkMerge';
import { hasWebLocks, SYNC_APPLY_LOCK, SYNC_FLUSH_LOCK, withCrossContextLock } from './crossContextLock';
import { getOrCreateDeviceId, getSyncCursor, setSyncCursor } from './deviceId';
import { dispatchOpFlush } from './dispatchOpFlush';
import { bulkPutItems } from './itemHelpers';
import { mergeServerOwnedRank } from './rankMerge';
import { confirmDelete, entityKey, isAwaitingDeleteEcho, rememberPushedDeletes, rememberQueuedDelete } from './unconfirmedDeletes';

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
    gcalMeta?: GCalOpMeta;
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
    const mergedId = await db.add('syncOperations', {
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
    // The merged row replaces a create a push may already have carried: it must stay "attempted"
    // so a delete after it is still kept (see pushAttemptedOpIds). Re-pushing the merged create is
    // safe either way — the server applies a create as a last-write-wins upsert.
    if (wasPushAttempted(queued)) {
        forgetPushAttempted([queued]);
        pushAttemptedOpIds.add(mergedId);
    }
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
    // Keyed on the (entityType, entityId) PAIR: an entityId is not globally unique — a sidecar
    // entity (itemBrief) deliberately borrows its parent item's id, and matching on the id alone
    // let a brief delete/update collapse away a pending item create (offline data loss).
    const existing = (await db.getAll('syncOperations')).filter((q) => q.entityType === entityType && q.entityId === entityId && q.opType !== 'rsvp');
    const hasPendingCreate = existing.some((q) => q.opType === 'create');

    // An update always folds into a pending create, even one a push has carried: the server applies
    // a create as a last-write-wins upsert, so re-pushing the merged snapshot is safe — whereas a
    // lone update for a row the server does not hold yet is quarantined (`skipped_missing`), which
    // a create + update pair in one batch can hit.
    if (opType === 'update' && hasPendingCreate) {
        await mergeUpdateIntoCreate(db, existing, op, userId);
        return;
    }

    if (opType === 'delete') {
        // Collapse the unsent prior ops. If the create itself is among them, the entity never reached
        // the server — drop everything. A create a push has carried (acknowledged or not — a timed-out
        // request may have committed) is different: the server may hold the row, so the delete must go
        // out and hold the entity back until its echo, or the next pull re-delivers the create into
        // the empty slot and resurrects the row. The attempted create stays queued ahead of it.
        await clearExistingOps(
            db,
            existing.filter((q) => !wasPushAttempted(q)),
        );
        if (existing.some(isUnsentCreate)) {
            return;
        }
        rememberQueuedDelete(entityKey(entityType, entityId));
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
    // The early returns above skip this on purpose: a merge leaves the entity's op queued (its badge
    // already says unsynced), and an annihilated create means the entity is gone.
    notifySyncQueueChanged();

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
 * Hard-deletes a synced row: the delete op is queued BEFORE the row goes. A pull applying between
 * the two steps then sees the queued delete and holds back stale re-deliveries of the entity; in
 * the other order it finds neither row nor op and resurrects what the user just deleted. Should the
 * context die in between, the server still deletes and the pulled-back delete removes the row.
 */
export async function queueDeleteThenRemove(db: IDBPDatabase<MyDB>, op: SyncOpParams, removeRow: () => Promise<void>): Promise<void> {
    await queueSyncOp(db, op);
    await removeRow();
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

// Per-filter in-context guard so concurrent callers (queueSyncOp fire-and-forget, mount effect,
// online handler, service worker message) collapse into a single in-flight pass per scope.
// Without this, two simultaneous flushes read the same queued ops and POST them twice,
// causing the server to send duplicate push notifications for the same change.
// Keyed by `userIdFilter` (like `pullStates`): a flush for user A that is WAITING on the
// cross-context lock must not be handed to the orchestrator's pass for user B — B's ops would
// go unflushed that pass, and A's push would later leave under B's pivoted cookie.
const flushInFlight = new Map<string, Promise<void>>();
const UNFILTERED_FLUSH_KEY = '*';

/** Wait for every in-flight sync flush to settle. Returns immediately if none is running. */
export function waitForPendingFlush(): Promise<void> {
    return Promise.allSettled(flushInFlight.values()).then(() => undefined);
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
    const key = options.userIdFilter ?? UNFILTERED_FLUSH_KEY;
    const existing = flushInFlight.get(key);
    if (existing) return existing;
    const pass = doFlush(db, options).finally(() => flushInFlight.delete(key));
    flushInFlight.set(key, pass);
    return pass;
}

// Cross-context flush lock: the main thread and Service Worker each have their own
// module-level flushInFlight guard, so they can race and POST the same ops twice.
// Preferred: the `gtd-sync-flush` Web Lock — a second context WAITS for the holder and then drains
// whatever the holder left, so a fire-and-forget dispatch can never be silently dropped. The IDB
// `deviceMeta.flushingTs` marker below is the fallback for browsers without Web Locks; it has to
// SKIP when held (no way to wait on it) and self-heals after a TTL.
const FLUSH_LOCK_TTL_MS = 30_000;

/**
 * Bound on waiting for the Web Lock. A holder's single request is capped by `PUSH_TIMEOUT_MS`, so a
 * wait that outlasts it by a margin means the holder is wedged somewhere other than the network (or
 * is draining a very long queue); give up and leave the ops queued for the next trigger (mount,
 * online, SSE, navigation) instead of hanging the caller. Note a flush awaited inside the session
 * gate can outlive the gate's 10s timeout — see `client/CLAUDE.md` § Offline Sync Queue.
 */
export const DEFAULT_FLUSH_LOCK_WAIT_MS = PUSH_TIMEOUT_MS + 15_000;
let flushLockWaitMs = DEFAULT_FLUSH_LOCK_WAIT_MS;

/** Test-only: shorten the Web Lock wait so the give-up path can be exercised without real time passing; restore with `DEFAULT_FLUSH_LOCK_WAIT_MS`. */
export function setFlushLockWaitMs(ms: number): void {
    flushLockWaitMs = ms;
}

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

function doFlush(db: IDBPDatabase<MyDB>, options: FlushOptions): Promise<void> {
    return hasWebLocks() ? flushUnderWebLock(db, options) : flushUnderIdbMarker(db, options);
}

/**
 * Queues behind any other context's flush, then drains. The wait is bounded (see `flushLockWaitMs`);
 * on give-up the ops stay queued — same outcome as the old skip, but only after a real attempt to
 * wait the holder out.
 */
async function flushUnderWebLock(db: IDBPDatabase<MyDB>, options: FlushOptions): Promise<void> {
    const lockWait = AbortSignal.timeout(flushLockWaitMs);
    try {
        await withCrossContextLock(SYNC_FLUSH_LOCK, () => pushQueuedOpsUntilEmpty(db, options), { signal: lockWait });
    } catch (err) {
        // Identity, not name: only the wait signal's own reason means "never granted". A DOMException
        // thrown by the task itself (an aborted IDB transaction, an aborted fetch) must propagate.
        if (err !== lockWait.reason) {
            throw err;
        }
        const leftBehind = (await readQueuedOpsForFlush(db, options)).length;
        console.warn(`[sync-flush] gave up waiting ${flushLockWaitMs}ms for the flush lock — ${leftBehind} ops stay queued for the next trigger`);
    }
}

async function flushUnderIdbMarker(db: IDBPDatabase<MyDB>, options: FlushOptions): Promise<void> {
    const lockResult = await acquireFlushLock(db);
    if (lockResult === 'heldByOther') {
        console.log('[sync-flush] skipping — another context holds the flush lock');
        return;
    }
    if (lockResult === 'noDeviceState') {
        return;
    }
    try {
        await pushQueuedOpsUntilEmpty(db, options);
    } finally {
        await releaseFlushLock(db).catch((e) => console.warn('[sync-flush] failed to release flush lock', e));
    }
}

/** Caller holds the flush lock. Mirrors the IDB path's "no device meta → nothing to push" short-circuit. */
async function pushQueuedOpsUntilEmpty(db: IDBPDatabase<MyDB>, options: FlushOptions): Promise<void> {
    if (!(await db.get('deviceMeta', 'local'))) {
        return;
    }
    // Loop until empty: a fire-and-forget flush from queueSyncOp may have started before
    // a subsequent mutation added more ops. Without the loop, those late-arriving ops
    // stay in IDB because the in-flight flush already read its batch before they existed.
    while (true) {
        const ops = await readNextPushBatch(db, options);
        if (!ops.length) {
            return;
        }
        await pushBatch(db, ops, options);
    }
}

async function pushBatch(db: IDBPDatabase<MyDB>, ops: SyncOperation[], options: FlushOptions): Promise<void> {
    // First, before any await: the batch is already read, so a queueSyncOp interleaving with the
    // device-id read below would otherwise still see these ops as unsent and collapse them.
    markPushAttempted(ops);
    console.log(
        `[sync-flush] pushing ${ops.length} ops to server (filter=${options.userIdFilter ?? 'all'})`,
        ops.map((op) => `${op.opType}:${op.entityType}:${op.entityId}`),
    );
    const deviceId = await getOrCreateDeviceId(db);
    await pushSyncOps(deviceId, ops);
    // Before dequeuing: from here until its echo is pulled, the delete is held only in memory.
    rememberPushedDeletes(ops);
    console.log(`[sync-flush] push succeeded, removed ${ops.length} ops from queue`);
    await deleteSentOps(db, ops);
}

/**
 * Queue rows some push request has carried, acknowledged or not. They stay in IDB until a request
 * succeeds, so `queueSyncOp` cannot tell them from unsent ops by the queue alone — and a request
 * that timed out or lost its connection may have committed, so the mark outlives a failed push and
 * is dropped only when the op leaves the queue. In memory, per context: a request another context
 * sent (a Service Worker's) is invisible here, and a reload forgets the marks — the same residual
 * as unconfirmedDeletes.ts.
 */
const pushAttemptedOpIds = new Set<number>();

/** The ids of queue rows — present on every record read from IDB; the type reflects pre-insert optionality. */
const queuedOpIds = (ops: SyncOperation[]) => ops.flatMap((op) => (op.id !== undefined ? [op.id] : []));

function markPushAttempted(ops: SyncOperation[]) {
    for (const id of queuedOpIds(ops)) {
        pushAttemptedOpIds.add(id);
    }
}

function forgetPushAttempted(ops: SyncOperation[]) {
    for (const id of queuedOpIds(ops)) {
        pushAttemptedOpIds.delete(id);
    }
}

const wasPushAttempted = (op: SyncOperation) => op.id !== undefined && pushAttemptedOpIds.has(op.id);
const isUnsentCreate = (op: SyncOperation) => op.opType === 'create' && !wasPushAttempted(op);

/** Test-only: a fresh fake-indexeddb database restarts its ids at 1, so a mark left by one test would land on the next test's op. */
export function __resetPushAttemptedForTests() {
    pushAttemptedOpIds.clear();
}

/** Batch succeeded — remove the sent ops in ONE transaction, so a context dying mid-way cannot leave half of them to be re-pushed. If the request failed, they stay for retry. */
async function deleteSentOps(db: IDBPDatabase<MyDB>, sent: SyncOperation[]): Promise<void> {
    const tx = db.transaction('syncOperations', 'readwrite');
    await Promise.all([...queuedOpIds(sent).map((id) => tx.store.delete(id)), tx.done]);
    forgetPushAttempted(sent);
    notifySyncQueueChanged();
}

/**
 * Reads the queued ops that this flush pass should send. When `userIdFilter` is set we keep only
 * the ops owned by that user; the multi-account orchestrator pivots `multiSession.setActive`
 * between calls so the server always sees a session matching the ops it receives.
 */
async function readQueuedOpsForFlush(db: IDBPDatabase<MyDB>, options: FlushOptions): Promise<SyncOperation[]> {
    const all = await db.getAll('syncOperations');
    return options.userIdFilter ? all.filter((op) => op.userId === options.userIdFilter) : all;
}

/** The next request's worth of ops, in `queuedAt` (= insertion) order; the drain loop sends the rest. */
async function readNextPushBatch(db: IDBPDatabase<MyDB>, options: FlushOptions): Promise<SyncOperation[]> {
    return (await readQueuedOpsForFlush(db, options)).slice(0, PUSH_BATCH_MAX);
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

// One bootstrap per account at a time. Two orchestrator passes can overlap past the session gate's
// timeout on a slow link; each found no cursor and downloaded the whole account again, racing the
// cursor and device-row writes. A second caller joins the running bootstrap instead.
const bootstrapsInFlight = new Map<string, Promise<void>>();

/**
 * Bootstrap without acquiring the session gate. Caller must already hold it. The IDB hydration runs
 * under the cross-context apply lock: the session gate is per-context, so without the lock a
 * Service Worker pull could interleave entity writes with this tab's snapshot hydration. The
 * network fetch stays OUTSIDE the lock — holding it across a slow request would wedge every other
 * context's sync for the duration (the exact failure mode the session gate's timeout exists for).
 */
export function bootstrapFromServerUnguarded(db: IDBPDatabase<MyDB>, userId: string): Promise<void> {
    const running = bootstrapsInFlight.get(userId);
    if (running) {
        return running;
    }
    const bootstrap = runBootstrap(db, userId).finally(() => bootstrapsInFlight.delete(userId));
    bootstrapsInFlight.set(userId, bootstrap);
    return bootstrap;
}

async function runBootstrap(db: IDBPDatabase<MyDB>, userId: string): Promise<void> {
    await assertActiveSessionMatches(db, userId, 'bootstrapFromServer');
    const deviceId = await getOrCreateDeviceId(db);

    // describeDevice gives the row a human-readable label for Settings → Connected devices.
    // navigator.userAgent exists in both window and Service Worker globals.
    const { items, routines, people, workContexts, reviewInboxes, itemBriefs, claudeAsks, serverTs, serverId } = await fetchBootstrap({
        deviceId,
        deviceLabel: describeDevice(navigator.userAgent),
        expectUserId: userId,
    });

    const mappedItems = items.map((doc) => remapUser(doc) as unknown as StoredItem);
    const mappedRoutines = routines.map((doc) => remapUser(doc) as unknown as StoredRoutine);
    const mappedPeople = people.map((doc) => remapUser(doc) as unknown as StoredPerson);
    const mappedWorkContexts = workContexts.map((doc) => remapUser(doc) as unknown as StoredWorkContext);
    // `?? []` — a server deployed before the reviewInboxes entity omits the field entirely.
    const mappedReviewInboxes = (reviewInboxes ?? []).map((doc) => remapUser(doc) as unknown as StoredReviewInbox);
    // Same `?? []` for itemBriefs — a server deployed before the entity omits the field entirely.
    const mappedItemBriefs = (itemBriefs ?? []).map((doc) => remapUser(doc) as unknown as StoredItemBrief);
    // And for claudeAsks — servers predating "Ask Claude" omit it.
    const mappedClaudeAsks = (claudeAsks ?? []).map((doc) => remapUser(doc) as unknown as StoredClaudeAsk);

    await withCrossContextLock(SYNC_APPLY_LOCK, async () => {
        if (await isRemovedFromDevice(db, userId)) {
            return;
        }
        await bulkPutItems(db, mappedItems);

        const routinesTx = db.transaction('routines', 'readwrite');
        await Promise.all([...mappedRoutines.map((r) => routinesTx.store.put(r)), routinesTx.done]);

        const peopleTx = db.transaction('people', 'readwrite');
        await Promise.all([...mappedPeople.map((p) => peopleTx.store.put(p)), peopleTx.done]);

        const workContextsTx = db.transaction('workContexts', 'readwrite');
        await Promise.all([...mappedWorkContexts.map((wc) => workContextsTx.store.put(wc)), workContextsTx.done]);

        const reviewInboxesTx = db.transaction('reviewInboxes', 'readwrite');
        await Promise.all([...mappedReviewInboxes.map((ri) => reviewInboxesTx.store.put(ri)), reviewInboxesTx.done]);

        const itemBriefsTx = db.transaction('itemBriefs', 'readwrite');
        await Promise.all([...mappedItemBriefs.map((brief) => itemBriefsTx.store.put(brief)), itemBriefsTx.done]);

        const claudeAsksTx = db.transaction('claudeAsks', 'readwrite');
        await Promise.all([...mappedClaudeAsks.map((ask) => claudeAsksTx.store.put(ask)), claudeAsksTx.done]);

        // Per-user compound cursor at (serverTs, serverId) — the snapshot already delivered the current
        // state, so incremental pull starts from here. The server holds the boundary a few seconds back
        // (serverId '' re-checks the boundary ms) so ops committing around the snapshot read are
        // re-delivered — idempotently — instead of skipped. `?? ''` is a type-level belt only (the
        // payload requires serverId); '' keeps the safe re-check-the-boundary-ms semantics if it ever
        // fires — the legacy MAX_OP_ID sentinel would skip that ms, the exact loss the holdback closes.
        await setSyncCursor(db, userId, serverTs, serverId ?? '');
        markVerifiedWithNetwork(userId);
    });
}

// Active-session-dependent operations (pulls, orchestrator passes) all read or mutate the global
// Better Auth session cookie. We serialize them through a single mutex so two parallel pulls for
// different users can't observe one user's session pivot mid-fetch and attribute that response to
// the wrong user's cursor (the failure mode H1/M1 in the per-user-cursor review). Per-user dedup
// (an SSE event arriving while a SW-push pull is in flight for the same user) is layered on top
// via `pullStates`.
let sessionGate: Promise<void> = Promise.resolve();

/**
 * Hard deadline for any single gate task. A stalled fetch (e.g. a session pivot retrying behind
 * a slow Google Calendar API call) used to wedge the gate forever, blocking every queued caller —
 * surfaced as the item editor hanging on cross-account reassign. After this deadline the gate is
 * released so queued tasks proceed; the original task keeps running and its eventual settlement
 * is logged but does not block the caller chain.
 *
 * Exposed for tests (via `setSessionGateTimeoutMs`) so timing-dependent specs can run fast.
 */
export const DEFAULT_SESSION_GATE_TIMEOUT_MS = 10_000;
let sessionGateTimeoutMs = DEFAULT_SESSION_GATE_TIMEOUT_MS;

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

/**
 * The user-selected active account. Read inside the session gate: a sync pass pivots IDB's active
 * pointer to each account it syncs and restores it before releasing the gate, so a bare read
 * mid-pass returns whichever account is being synced. A pass that outlives the gate's hard timeout
 * releases it early, so the read also resolves past any pivot still in flight.
 */
export function readSettledActiveAccount(db: IDBPDatabase<MyDB>) {
    return withSessionGate(() => getIntendedActiveAccount(db));
}

/**
 * Per-user pull bookkeeping. "Queued" (a gated pull waiting for the session gate) is kept apart from
 * "running" (a pull past the gate, or an unguarded one): the orchestrator holds the gate while it
 * calls `pullFromServerUnguarded`, so joining a queued pull there would wait on the gate it holds
 * until the gate's hard timeout, then race that pull through the pass's session pivots.
 */
interface UserPullState {
    /** A gated pull waiting for the session gate. Only `pullFromServer` may join it. */
    queued?: Promise<void> | undefined;
    /** The pull past the gate (or unguarded) — joinable by both entry points while not yet reading. */
    running?: Promise<void> | undefined;
    /** The running pull has sent its request: what it returns was read before any later commit. */
    isReading: boolean;
    /** One follow-up shared by every request made while the running pull was reading. */
    followUp?: Promise<void> | undefined;
}

const pullStates = new Map<string, UserPullState>();

function pullStateOf(userId: string): UserPullState {
    const existing = pullStates.get(userId);
    if (existing) {
        return existing;
    }
    const created: UserPullState = { isReading: false };
    pullStates.set(userId, created);
    return created;
}

/**
 * Per-user pull that acquires the session gate. Use from any caller outside the orchestrator
 * (SSE handler, devTools). The orchestrator calls `pullFromServerUnguarded` to avoid recursing
 * into the gate it already holds.
 *
 * A request joins a pull that has not sent its request yet (it will read the change the request
 * announces — SSE notifies after the commit). Once the pull is reading, it may have read the server
 * before that change was committed (a server burst sends one notification per op), so the request
 * gets one fresh pull after it instead: at most one extra pull per in-flight pull, shared by every
 * request made meanwhile.
 */
export function pullFromServer(db: IDBPDatabase<MyDB>, userId: string): Promise<void> {
    const state = pullStateOf(userId);
    if (state.running) {
        return state.isReading ? followUpPull(db, userId, state.running) : state.running;
    }
    return state.queued ?? queueGatedPull(db, userId);
}

function queueGatedPull(db: IDBPDatabase<MyDB>, userId: string): Promise<void> {
    const state = pullStateOf(userId);
    // Holder, because the gate task needs the promise `withSessionGate` is about to return.
    const queuedPull: { promise?: Promise<void> } = {};
    queuedPull.promise = withSessionGate(() => {
        // Past the gate: from here on it is a running pull the orchestrator may join.
        if (state.queued === queuedPull.promise) {
            state.queued = undefined;
        }
        // A pass that outlived the gate's hard timeout released the gate while its unguarded pull
        // still runs: wait for it rather than run a second doPull for this user alongside it.
        return state.running ? state.running.catch(() => undefined).then(() => runTrackedPull(db, userId)) : runTrackedPull(db, userId);
    });
    state.queued = queuedPull.promise;
    return queuedPull.promise;
}

/** Registers the pull as running for the whole of `doPull`, and clears it — and its reading flag — when it settles. */
function runTrackedPull(db: IDBPDatabase<MyDB>, userId: string): Promise<void> {
    const state = pullStateOf(userId);
    const running = doPull(db, userId).finally(() => {
        if (state.running === running) {
            state.running = undefined;
            state.isReading = false;
        }
    });
    state.running = running;
    return running;
}

/** A failure a second request would hit in exactly the same way — no point in a follow-up. */
function isTerminalPullFailure(err: unknown): boolean {
    return err instanceof SyncAuthError || err instanceof BootstrapRequiredError || err instanceof SessionUserMismatchError;
}

function followUpPull(db: IDBPDatabase<MyDB>, userId: string, running: Promise<void>): Promise<void> {
    const state = pullStateOf(userId);
    if (state.followUp) {
        return state.followUp;
    }
    const startFollowUp = () => {
        state.followUp = undefined;
        return pullFromServer(db, userId);
    };
    // A plain failure did not cover the request either, so the follow-up still runs; an auth or
    // reaped-device failure is handed to every waiting request instead.
    const followUp = running.then(startFollowUp, (err: unknown) => {
        if (isTerminalPullFailure(err)) {
            state.followUp = undefined;
            throw err;
        }
        return startFollowUp();
    });
    state.followUp = followUp;
    return followUp;
}

/**
 * Per-user pull WITHOUT acquiring the session gate. Caller must already hold it. It joins only a
 * RUNNING pull — never one queued for the gate the caller holds (see `UserPullState`).
 */
export function pullFromServerUnguarded(db: IDBPDatabase<MyDB>, userId: string): Promise<void> {
    const existing = pullStateOf(userId).running;
    if (existing) {
        return existing;
    }
    return runTrackedPull(db, userId);
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
    const outcome = await storeAllPages(db, userId, pullPages(db, userId, deviceId)).catch((err: unknown) => {
        // A page failed to arrive or to apply: the device may have missed changes — its badges say
        // so, and the catch-up retrier tries again. Pages stored before it stay stored.
        forgetNetworkVerificationFor(userId);
        throw err;
    });
    recordPullOutcome(userId, outcome);
}

/**
 * Ops a pull may ask for in one page. A device back from weeks offline otherwise downloads every
 * missed op in one response — slow, and on a weak link easily cut off and started over.
 */
export const PULL_PAGE_SIZE = 200;
const pullPaging = { pageSize: PULL_PAGE_SIZE };

/** Test-only (e2e harness): a small page size lets a spec page through a handful of ops. */
export function setPullPageSize(size: number): void {
    pullPaging.pageSize = size;
}

/** How a pull ended. Only `complete` means the device now holds everything the server had. */
type PullOutcome = 'complete' | 'accountRemoved' | 'sessionChanged' | 'cursorStalled';

interface PulledPage {
    page: PullPayload;
    /** The stored cursor the page was requested from (and acknowledged). */
    requestedFrom: OpCursor;
}

/**
 * Yields `/sync/pull` pages until the server reports none left. Each request reads the cursor the
 * consumer stored for the previous page, so it both resumes from and acknowledges exactly what the
 * device has durably written — the server never advances the purge floor past it.
 */
async function* pullPages(db: IDBPDatabase<MyDB>, userId: string, deviceId: string): AsyncGenerator<PulledPage> {
    for (;;) {
        const requestedFrom = await getSyncCursor(db, userId);
        // From the first request on, the server's answer may predate a write: a pull requested now
        // gets a follow-up instead of joining this one (see UserPullState). Cleared by the wrapper.
        pullStateOf(userId).isReading = true;
        const page = await fetchSyncOps({ cursor: requestedFrom, acked: requestedFrom, deviceId, limit: pullPaging.pageSize, expectUserId: userId });
        console.log('[sync] pull page', {
            userId,
            since: requestedFrom,
            next: { ts: page.serverTs, id: page.serverId },
            opCount: page.ops.length,
            hasMore: page.hasMore === true,
        });
        yield { page, requestedFrom };
        if (page.hasMore !== true) {
            return;
        }
    }
}

/** Stores each page in turn, checking before every further request that paging may go on. */
async function storeAllPages(db: IDBPDatabase<MyDB>, userId: string, pages: AsyncGenerator<PulledPage>): Promise<PullOutcome> {
    for await (const { page, requestedFrom } of pages) {
        const stored = await storePulledPage(db, userId, page);
        if (stored === 'accountRemoved') {
            return stored;
        }
        const blocker = page.hasMore === true ? await reasonNotToRequestNextPage(db, userId, requestedFrom) : undefined;
        if (blocker) {
            return blocker;
        }
    }
    return 'complete';
}

/**
 * Re-checked before every page after the first. The pull holds the session gate, but the gate
 * releases a task after its hard timeout while the task keeps running — a slow multi-page catch-up
 * can outlive it, a queued pass can switch the active session, and the next page would then go out
 * under another account's cookie (its ops applied here, its device row acknowledged with our cursor).
 * A page that claims more remain but did not move the cursor would be requested forever.
 */
async function reasonNotToRequestNextPage(db: IDBPDatabase<MyDB>, userId: string, requestedFrom: OpCursor): Promise<PullOutcome | undefined> {
    if ((await getActiveAccount(db))?.id !== userId) {
        return 'sessionChanged';
    }
    const stored = await getSyncCursor(db, userId);
    return stored.ts === requestedFrom.ts && stored.id === requestedFrom.id ? 'cursorStalled' : undefined;
}

function recordPullOutcome(userId: string, outcome: PullOutcome): void {
    if (outcome === 'complete') {
        markVerifiedWithNetwork(userId);
        return;
    }
    if (outcome !== 'accountRemoved') {
        // The pull stopped short of the server's head: what the device holds is not verified.
        console.log('[sync] pull stopped before the last page', { userId, outcome });
        forgetNetworkVerificationFor(userId);
    }
}

/**
 * Applies one page and advances the cursor past it. `accountRemoved` when the account left the
 * device while the request was in flight: the page is dropped and paging stops.
 *
 * Cross-context lock around apply + ack: `pullStates`/`sessionGate` only dedupe within THIS
 * context, but every tab and the Service Worker share one IndexedDB. Two contexts pulling
 * different accounts can interleave applies for the same entityId (a cross-account reassign emits
 * delete+create under two users) — the delete's owner guard then reads a row the other context is
 * mid-replace, and the entity vanishes from IDB while the server stays correct. The network fetch
 * stays OUTSIDE the lock so a slow request can't wedge every other context's sync; the per-op
 * transaction in `applyEntityOp` is the second layer for browsers without Web Locks.
 */
function storePulledPage(db: IDBPDatabase<MyDB>, userId: string, { ops, serverTs, serverId }: PullPayload): Promise<'stored' | 'accountRemoved'> {
    return withCrossContextLock(SYNC_APPLY_LOCK, async () => {
        if (await isRemovedFromDevice(db, userId)) {
            return 'accountRemoved';
        }
        await applyPulledOps(db, userId, ops);
        await advanceSyncCursor(db, userId, serverTs, serverId ?? '');
        return 'stored';
    });
}

/**
 * The account left this device while its request was in flight (deleted and evaporated, or signed
 * out). Checked inside the apply lock — `removeAccountAndData` takes the same lock — so the
 * response is dropped instead of writing rows and a cursor back for an account the wipe removed.
 */
async function isRemovedFromDevice(db: IDBPDatabase<MyDB>, userId: string) {
    const isRemoved = !(await isAccountOnDevice(db, userId));
    if (isRemoved) {
        console.log('[sync] dropping a response for an account removed from this device', { userId });
    }
    return isRemoved;
}

/**
 * Applies a pull's ops in server order, skipping stale re-deliveries for entities this device has
 * deleted: the server re-sends the last few seconds of ops on every pull (the holdback window), and
 * a pull fetched before a local delete can land after it. With the row gone there is nothing for
 * LWW to compare against, so applying it would resurrect what the user just deleted. Held back
 * while the delete is still queued, and after it is pushed until the server's own delete op comes
 * back (see unconfirmedDeletes.ts). In order, so an op after that echo — a genuine re-create — applies.
 */
async function applyPulledOps(db: IDBPDatabase<MyDB>, userId: string, ops: ServerOp[]): Promise<void> {
    const queuedDeletes = await readQueuedDeleteKeys(db);
    for (const op of ops) {
        const key = entityKey(op.entityType, op.entityId);
        if (op.opType !== 'delete' && (queuedDeletes.has(key) || isAwaitingDeleteEcho(key))) {
            continue;
        }
        await applyServerOp(db, userId, op);
        // Released only once applied: a delete whose apply threw keeps holding until a pull re-delivers it.
        if (op.opType === 'delete') {
            confirmDelete(key);
        }
    }
}

/** Entities this device deleted locally and has not pushed yet. Read inside the apply lock, per pull. */
async function readQueuedDeleteKeys(db: IDBPDatabase<MyDB>): Promise<Set<string>> {
    const queued = await db.getAll('syncOperations');
    return new Set(queued.filter((op) => op.opType === 'delete').map((op) => entityKey(op.entityType, op.entityId)));
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
        case 'itemBrief':
            return applyEntityOp(db, 'itemBriefs', pullUserId, op);
        case 'claudeAsk':
            return applyEntityOp(db, 'claudeAsks', pullUserId, op);
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
type EntityStoreName = 'items' | 'routines' | 'people' | 'workContexts' | 'reviewInboxes' | 'itemBriefs' | 'claudeAsks';

/**
 * Applies a brief row the server handed straight back to this device (the on-demand generate
 * endpoint) through the SAME owner/LWW rule the pull path uses, so the SSE-driven pull that
 * delivers the identical op moments later is an idempotent no-op — and an older snapshot can
 * never clobber a newer local row. Server-authored, so no sync op is queued. A `text: null`
 * (skipped) row is stored verbatim; the UI derives `none` from it.
 */
export async function applyServerItemBrief(db: IDBPDatabase<MyDB>, snapshot: ServerItemBriefSnapshot): Promise<void> {
    await applyEntityOp(db, 'itemBriefs', snapshot.user, { entityType: 'itemBrief', entityId: snapshot._id, opType: 'update', snapshot });
}

/**
 * Applies the ask row the start endpoint handed back through the same owner/LWW rule as the pull
 * path, so the SSE-driven pull delivering the identical op moments later is an idempotent no-op.
 * Server-authored, so no sync op is queued.
 */
export async function applyServerClaudeAsk(db: IDBPDatabase<MyDB>, snapshot: ServerClaudeAskSnapshot): Promise<void> {
    await applyEntityOp(db, 'claudeAsks', snapshot.user, { entityType: 'claudeAsk', entityId: snapshot._id, opType: 'update', snapshot });
}

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
        await tx.done;
        return;
    }
    console.log(
        `[debug-gcal-sync][client] applyEntityOp skipped (LWW) | type=${op.entityType} id=${op.entityId} existingTs=${existing.updatedTs} incomingTs=${incoming.updatedTs}`,
    );
    // The lost snapshot may still carry server-owned calendar fields this device never saw (the
    // Google link stamped after the create) — merge those in without touching the newer local state.
    const merged = mergeServerOwnedFieldsIntoNewerRow(storeName, existing, incoming);
    if (merged) {
        await tx.store.put(merged);
        console.log(`[debug-gcal-sync][client] applyEntityOp merged server-owned fields (calendar link / rank) into newer local row | id=${op.entityId}`);
    }
    await tx.done;
}

/**
 * Store-dispatched wrapper around the items store's field-level LWW exceptions — the server-owned
 * calendar fields (`mergeServerOwnedCalendarFields`) and the priority `rank` (`mergeServerOwnedRank`).
 * The casts narrow the generic store value to `StoredItem` once `storeName` has proven it — the
 * same trust the caller places in the wire snapshot.
 */
function mergeServerOwnedFieldsIntoNewerRow<Name extends EntityStoreName>(
    storeName: Name,
    existing: { updatedTs: string; userId: string },
    incoming: MyDB[Name]['value'],
): MyDB[Name]['value'] | null {
    if (storeName !== 'items') {
        return null;
    }
    const local = existing as StoredItem;
    const withCalendar = mergeServerOwnedCalendarFields(local, incoming as StoredItem);
    const withRank = mergeServerOwnedRank(withCalendar ?? local, incoming as StoredItem);
    return (withRank ?? withCalendar) as MyDB[Name]['value'] | null;
}
