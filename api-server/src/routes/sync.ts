import dayjs from 'dayjs';
import { Hono } from 'hono';
import { authenticateRequest } from '../auth/middleware.js';
import deviceSyncStateDAO from '../dataAccess/deviceSyncStateDAO.js';
import itemsDAO from '../dataAccess/itemsDAO.js';
import operationsDAO from '../dataAccess/operationsDAO.js';
import pushSubscriptionsDAO from '../dataAccess/pushSubscriptionsDAO.js';
import { addSseConnection, notifyUser, removeSseConnection } from '../lib/sseConnections.js';
import { sendPushToSubscription, vapidPublicKey } from '../lib/webPush.js';
import type { AuthVariables } from '../types/authTypes.js';
import type { EntityType, ItemInterface, OperationInterface, OpType } from '../types/entities.js';

// Shape of each operation as sent by the client — mirrors the client SyncOperation type.
// Snapshot uses `userId` (IndexedDB field name); the server remaps it to `user`.
interface ClientOp {
    entityType: EntityType;
    entityId: string;
    opType: OpType;
    queuedAt: string;
    snapshot: (Record<string, unknown> & { userId?: string }) | null;
}

async function applyItemOp(userId: string, entityId: string, opType: OpType, snapshot: ItemInterface | null): Promise<void> {
    if (opType === 'delete') {
        // userId guard ensures a user can never delete another user's item via a crafted op
        await itemsDAO.collection.deleteOne({ _id: entityId, user: userId } as never);
        return;
    }
    if (!snapshot) return;

    // Two-step last-write-wins: fetch current then replace only if incoming is newer or equal.
    // Simpler than a conditional upsert query; safe for the low-throughput GTD use case.
    const existing = await itemsDAO.collection.findOne({ _id: entityId, user: userId } as never);
    if (!existing || existing.updatedTs <= snapshot.updatedTs) {
        await itemsDAO.collection.replaceOne({ _id: entityId } as never, snapshot, { upsert: true });
    }
}

// Cast filter/update objects to `never` to work around MongoDB driver's `InferIdType`
// widening `_id` to `ObjectId` when the collection schema declares it optional.
type MongoFilter = Record<string, unknown>;

export const syncRoutes = new Hono<{ Variables: AuthVariables }>()
    // ---------------------------------------------------------------------------
    // POST /sync/push  — client sends a batch of queued operations
    // ---------------------------------------------------------------------------
    .post('/push', authenticateRequest, async (c) => {
        const { user } = c.get('session');
        const { deviceId, ops } = await c.req.json<{ deviceId: string; ops: ClientOp[] }>();
        if (!ops.length) return c.json({ ok: true }, 200);

        const now = dayjs().toISOString();

        const serverOps: OperationInterface[] = ops.map((op) => {
            // Strip client-side `userId` and inject server-authoritative `user` from session
            const { userId: _stripped, ...snapshotFields } = op.snapshot ?? {};
            const snapshot = op.snapshot ? ({ ...snapshotFields, user: user.id } as ItemInterface) : null;
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

        await Promise.all([
            operationsDAO.insertMany(serverOps),
            ...serverOps.map((op) => applyItemOp(user.id, op.entityId, op.opType, op.snapshot as ItemInterface | null)),
        ]);

        await deviceSyncStateDAO.updateOne(
            { _id: deviceId } as MongoFilter as never,
            { $set: { lastSeenTs: now, user: user.id }, $setOnInsert: { lastSyncedTs: new Date(0).toISOString() } } as never,
            { upsert: true },
        );

        notifyUser(user.id, { type: 'update', ts: now });

        // Web Push for devices that aren't currently connected via SSE (app closed)
        const pushSubs = await pushSubscriptionsDAO.findArray({ user: user.id, _id: { $ne: deviceId } } as MongoFilter as never);
        await Promise.allSettled(pushSubs.map((sub) => sendPushToSubscription(sub, { type: 'update', ts: now })));

        return c.json({ ok: true }, 200);
    })

    // ---------------------------------------------------------------------------
    // GET /sync/pull  — client fetches operations it hasn't seen yet
    // ---------------------------------------------------------------------------
    .get('/pull', authenticateRequest, async (c) => {
        const { user } = c.get('session');
        const since = c.req.query('since') ?? new Date(0).toISOString();
        const deviceId = c.req.query('deviceId');

        const ops = await operationsDAO.findArray(
            { user: user.id, ts: { $gt: since } } as MongoFilter as never,
            { sort: { ts: 1 } },
        );

        const serverTs = dayjs().toISOString();

        if (deviceId) {
            // Track per-device pull cursor so old operations can eventually be purged
            await deviceSyncStateDAO.updateOne(
                { _id: deviceId } as MongoFilter as never,
                { $set: { lastSyncedTs: serverTs, user: user.id }, $setOnInsert: { lastSeenTs: new Date(0).toISOString() } } as never,
                { upsert: true },
            );
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
                    try { controller.close(); } catch { /* already closed */ }
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
