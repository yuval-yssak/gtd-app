import dayjs from 'dayjs';
import { Hono } from 'hono';
import { authenticateRequest } from '../auth/middleware.js';
import type AbstractDAO from '../dataAccess/abstractDAO.js';
import deviceSyncStateDAO from '../dataAccess/deviceSyncStateDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import peopleDAO from '../dataAccess/peopleDAO.js';
import pushSubscriptionsDAO from '../dataAccess/pushSubscriptionsDAO.js';
import routinesDAO from '../dataAccess/routinesDAO.js';
import workContextsDAO from '../dataAccess/workContextsDAO.js';
import { addSseConnection, notifyUserViaSse, removeSseConnection } from '../lib/sseConnections.js';
import { sendPushToSubscription, vapidPublicKey } from '../lib/webPush.js';
import type { AuthVariables } from '../types/authTypes.js';
import type { EntityType, ItemInterface, OperationInterface, OpType, PersonInterface, RoutineInterface, WorkContextInterface } from '../types/entities.js';
import { inspect } from 'node:util';

// Shape of each operation as sent by the client — mirrors the client SyncOperation type.
// Snapshot uses `userId` (IndexedDB field name); the server remaps it to `user`.
interface ClientOp {
    entityType: EntityType;
    entityId: string;
    opType: OpType;
    queuedAt: string;
    snapshot: (Record<string, unknown> & { userId?: string }) | null;
}

type EntitySnapshot = ItemInterface | RoutineInterface | PersonInterface | WorkContextInterface;

// Items and routines use `title`; people and workContexts use `name`
function entityDisplayName(snapshot: EntitySnapshot): string {
    return 'title' in snapshot ? snapshot.title : snapshot.name;
}

// Cast filter/update objects to `never` to work around MongoDB driver's `InferIdType`
// widening `_id` to `ObjectId` when the collection schema declares it optional.
type MongoFilter = Record<string, unknown>;

// Single generic helper replacing four near-identical applyXxxOp functions.
// The DAO provides deleteByOwner / findByOwnerAndId / replaceById; the only
// varying pieces are the DAO instance and the snapshot type.
async function applyEntitySnapshotOp<T extends EntitySnapshot>(
    dao: AbstractDAO<T>,
    userId: string,
    entityId: string,
    opType: OpType,
    snapshot: T | null,
): Promise<void> {
    if (opType === 'delete') {
        // userId guard ensures a user can never delete another user's entity via a crafted op
        await dao.deleteByOwner(entityId, userId);
        return;
    }
    if (!snapshot) {
        return;
    }

    // Two-step last-write-wins: fetch current then replace only if incoming is newer or equal.
    // Simpler than a conditional upsert query; safe for the low-throughput GTD use case.
    const existing = await dao.findByOwnerAndId(entityId, userId);
    if (!existing || existing.updatedTs <= snapshot.updatedTs) {
        await dao.replaceById(entityId, snapshot);
    }
}

function applyEntityOp(userId: string, op: OperationInterface): Promise<void> {
    const { entityType, entityId, opType, snapshot } = op;
    switch (entityType) {
        case 'item':
            return applyEntitySnapshotOp(itemsDAO, userId, entityId, opType, snapshot as ItemInterface | null);
        case 'routine':
            return applyEntitySnapshotOp(routinesDAO, userId, entityId, opType, snapshot as RoutineInterface | null);
        case 'person':
            return applyEntitySnapshotOp(peopleDAO, userId, entityId, opType, snapshot as PersonInterface | null);
        case 'workContext':
            return applyEntitySnapshotOp(workContextsDAO, userId, entityId, opType, snapshot as WorkContextInterface | null);
    }
}

async function purgeOldOperations(userId: string): Promise<void> {
    const deviceStates = await deviceSyncStateDAO.findArray({ user: userId } as MongoFilter as never);
    if (!deviceStates.length) {
        return;
    }

    // Only purge ops all registered devices have already pulled — the slowest device sets the floor.
    // reduce without an initial value uses the first element as the accumulator seed; TypeScript
    // types this as returning the element type (not T | undefined), safe since we guard length above.
    const minLastSyncedTs = deviceStates.map((d) => d.lastSyncedTs).reduce((min, ts) => (ts < min ? ts : min));

    await operationsDAO.deleteOlderThan(userId, minLastSyncedTs);
}

async function notifyViaWebPush(userId: string, excludeDeviceId: string, ops: OperationInterface[], now: string): Promise<void> {
    const opSummaries = ops.map((op) => ({
        entityType: op.entityType,
        opType: op.opType,
        name: op.snapshot ? entityDisplayName(op.snapshot) : null,
    }));
    console.log(`[push] notifying ${userId} of ${ops.length} ops (excluding device ${excludeDeviceId}):`, opSummaries);
    console.log(inspect(opSummaries, { depth: Infinity, colors: true, maxArrayLength: Infinity }));
    const pushSubs = await pushSubscriptionsDAO.findArray({ user: userId, _id: { $ne: excludeDeviceId } });
    console.log(`[push] found ${pushSubs.length} subscriptions for user ${userId}`);
    const pushResults = await Promise.allSettled(pushSubs.map((sub) => sendPushToSubscription(sub, { type: 'update', ts: now, ops: opSummaries })));
    pushResults.forEach((result, i) => {
        if (result.status === 'rejected') {
            console.error(`[push] failed to notify device ${pushSubs[i]?._id}:`, result.reason);
        }
    });
}

export const syncRoutes = new Hono<{ Variables: AuthVariables }>()
    // ---------------------------------------------------------------------------
    // GET /sync/bootstrap  — full entity snapshot for new/re-syncing devices
    // ---------------------------------------------------------------------------
    // New devices cannot use /sync/pull because historical ops may have been purged
    // before the device registered. Bootstrap reads directly from entity collections
    // (the permanent ground truth) and returns serverTs so the device can start
    // incremental pull from that point forward without replaying any ops.
    .get('/bootstrap', authenticateRequest, async (c) => {
        const { user } = c.get('session');

        const [items, routines, people, workContexts] = await Promise.all([
            itemsDAO.findArray({ user: user.id } as MongoFilter as never),
            routinesDAO.findArray({ user: user.id } as MongoFilter as never),
            peopleDAO.findArray({ user: user.id } as MongoFilter as never),
            workContextsDAO.findArray({ user: user.id } as MongoFilter as never),
        ]);

        return c.json({ items, routines, people, workContexts, serverTs: dayjs().toISOString() });
    })

    // ---------------------------------------------------------------------------
    // POST /sync/push  — client sends a batch of queued operations
    // ---------------------------------------------------------------------------
    .post('/push', authenticateRequest, async (c) => {
        const { user } = c.get('session');
        const { deviceId, ops } = await c.req.json<{ deviceId: string; ops: ClientOp[] }>();
        if (!ops.length) {
            return c.json({ ok: true }, 200);
        }

        const now = dayjs().toISOString();

        const serverOps = ops.map<OperationInterface>((op) => {
            // Strip client-side `userId` and inject server-authoritative `user` from session
            const { userId: _stripped, ...snapshotFields } = op.snapshot ?? {};
            const snapshot = op.snapshot ? ({ ...snapshotFields, user: user.id } as EntitySnapshot) : null;
            return {
                _id: crypto.randomUUID(),
                user: user.id,
                deviceId,
                ts: now,
                entityType: op.entityType,
                entityId: op.entityId,
                opType: op.opType,
                snapshot,
            };
        });

        await Promise.all([operationsDAO.insertMany(serverOps), ...serverOps.map((op) => applyEntityOp(user.id, op))]);

        await deviceSyncStateDAO.updateOne(
            { _id: deviceId } as MongoFilter as never,
            { $set: { lastSeenTs: now, user: user.id }, $setOnInsert: { lastSyncedTs: dayjs(0).toISOString() } } as never,
            { upsert: true },
        );

        notifyUserViaSse(user.id, { type: 'update', ts: now });

        // Web Push for devices that aren't currently connected via SSE (app closed).
        // Include per-op summaries so the SW can show a meaningful notification body
        // (e.g. "Updated: Call dentist") instead of a generic message.
        await notifyViaWebPush(user.id, deviceId, serverOps, now);

        return c.json({ ok: true }, 200);
    })

    // ---------------------------------------------------------------------------
    // GET /sync/pull  — client fetches operations it hasn't seen yet
    // ---------------------------------------------------------------------------
    .get('/pull', authenticateRequest, async (c) => {
        const { user } = c.get('session');
        const since = c.req.query('since') ?? dayjs(0).toISOString();
        const deviceId = c.req.query('deviceId');

        const ops = await operationsDAO.findArray({ user: user.id, ts: { $gt: since } } as MongoFilter as never, { sort: { ts: 1 } });

        const serverTs = dayjs().toISOString();

        if (deviceId) {
            // Track per-device pull cursor so old operations can eventually be purged
            await deviceSyncStateDAO.updateOne(
                { _id: deviceId } as MongoFilter as never,
                { $set: { lastSyncedTs: serverTs, user: user.id }, $setOnInsert: { lastSeenTs: dayjs(0).toISOString() } },
                { upsert: true },
            );

            // Fire-and-forget: purge ops all devices have already seen to cap storage growth.
            // Async so the pull response isn't blocked by the deletion query.
            purgeOldOperations(user.id).catch(() => {});
        }

        return c.json({ ops, serverTs });
    })

    // ---------------------------------------------------------------------------
    // GET /events  — SSE stream; server pushes { type: 'update', ts } on changes
    // ---------------------------------------------------------------------------
    .get('/events', authenticateRequest, async (c) => {
        const { user } = c.get('session');

        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                addSseConnection(user.id, controller);

                // Initial comment keeps the connection open and confirms it's alive to the client
                controller.enqueue(new TextEncoder().encode(': connected\n\n'));

                // Remove from map when client disconnects; EventSource will auto-reconnect
                c.req.raw.signal.addEventListener('abort', () => {
                    removeSseConnection(user.id, controller);
                    try {
                        controller.close();
                    } catch {
                        /* already closed */
                    }
                });
            },
        });

        return new Response(stream, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                // Disable proxy/CDN buffering so events reach the client immediately
                'X-Accel-Buffering': 'no',
            },
        });
    })

    // GET /sync/config — exposes the VAPID public key so the client can subscribe without a secret
    .get('/config', (c) => c.json({ vapidPublicKey }));
