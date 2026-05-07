import { createHmac, randomUUID } from 'node:crypto';
import dayjs from 'dayjs';
import webhookDeliveriesDAO from '../dataAccess/webhookDeliveriesDAO.js';
import webhookSubscriptionsDAO from '../dataAccess/webhookSubscriptionsDAO.js';
import type { ItemInterface, OperationInterface, WebhookDeliveryInterface, WebhookEvent, WebhookSubscriptionInterface } from '../types/entities.js';

/**
 * In-process webhook delivery worker.
 *
 * Storage rationale: webhookDeliveries lives in Mongo so a server restart doesn't drop in-flight
 * deliveries. The worker uses an optimistic-claim pattern (`findOneAndUpdate { claimed: false → true }`)
 * so two instances running concurrently never deliver the same row twice. Single-Cloud-Run-instance
 * deployments don't strictly need this, but it costs little and unblocks horizontal scaling later.
 *
 * Retry policy: backoff 1m → 5m → 30m. After 3 attempts the delivery is abandoned. The parent
 * subscription tracks consecutive failures across all its deliveries; after `MAX_FAILURES` it is
 * auto-disabled so a dead endpoint can't keep generating zombie deliveries.
 */
export const RETRY_DELAYS_MS: ReadonlyArray<number> = [60_000, 5 * 60_000, 30 * 60_000];
export const MAX_DELIVERY_ATTEMPTS = RETRY_DELAYS_MS.length;
export const MAX_CONSECUTIVE_FAILURES_BEFORE_DISABLE = 7;
const DELIVERY_TIMEOUT_MS = 10_000;
const WORKER_TICK_INTERVAL_MS = 5_000;
const CLAIMS_PER_TICK = 10;

type DeliveryFetcher = (input: string, init: RequestInit) => Promise<{ ok: boolean; status: number; statusText: string }>;

export interface WorkerDeps {
    /** Override fetch (used in tests to assert request shape and simulate failures). */
    fetchImpl?: DeliveryFetcher;
    /** Override clock (used by fake-time tests). */
    now?: () => Date;
}

/**
 * Computes the HMAC-SHA256 signature header value for an outgoing delivery.
 * Format: `sha256=<hex>`. Subscribers verify by recomputing with their secret.
 */
export function signDeliveryBody(secret: string, body: string): string {
    const hex = createHmac('sha256', secret).update(body).digest('hex');
    return `sha256=${hex}`;
}

/**
 * Maps a recorded operation to the webhook events it should fan out to. Pure — no I/O.
 * Currently item-only; future entity types (people, contexts, routines) plug in here.
 */
export function mapOpToEvents(op: OperationInterface): WebhookEvent[] {
    if (op.entityType !== 'item' || !op.snapshot) {
        return [];
    }
    const item = op.snapshot as ItemInterface;
    if (op.opType === 'create' && item.status === 'inbox') {
        return ['item.created'];
    }
    if (op.opType === 'update' && item.status === 'done') {
        return ['item.completed'];
    }
    return [];
}

/**
 * Enqueues one webhookDeliveries row per matching active subscription. Caller fires this
 * from `notifyChange` (`v1Items.ts`) on every public-API mutation. No-ops when there are no
 * matching subscriptions, which is the common case for users who haven't set webhooks up.
 *
 * `nowIso` defaults to the real wall clock; tests pin it so the queued `nextAttemptTs` and
 * the worker's `now` come from the same fake clock (otherwise a test running in the future
 * sees a delivery scheduled for "now" that's still ahead of its hardcoded tick time).
 */
export async function enqueueWebhookDeliveries(op: OperationInterface, nowIso: string = dayjs().toISOString()): Promise<void> {
    const events = mapOpToEvents(op);
    if (events.length === 0) {
        return;
    }
    const now = nowIso;
    for (const event of events) {
        const subs = await webhookSubscriptionsDAO.listActiveForEvent(op.user, event);
        if (subs.length === 0) {
            continue;
        }
        const rows: WebhookDeliveryInterface[] = subs.map((sub) => ({
            _id: randomUUID(),
            user: op.user,
            subscriptionId: sub._id,
            event,
            payload: { event, ts: op.ts, item: op.snapshot },
            attempts: 0,
            nextAttemptTs: now,
        }));
        await Promise.all(rows.map((row) => webhookDeliveriesDAO.insertOne(row)));
    }
}

interface DeliverOneResult {
    delivered: boolean;
    abandoned: boolean;
}

/**
 * Attempts a single delivery. The fetch is wrapped with a timeout so a hanging endpoint can't
 * stall the worker. On success, marks delivered and resets the subscription's failure count.
 * On failure, schedules retry or abandons after MAX_DELIVERY_ATTEMPTS.
 */
async function deliverOne(
    delivery: WebhookDeliveryInterface,
    sub: WebhookSubscriptionInterface,
    deps: { fetchImpl: DeliveryFetcher; now: () => Date },
): Promise<DeliverOneResult> {
    const body = JSON.stringify(delivery.payload);
    const signature = signDeliveryBody(sub.secret, body);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    const attempts = (delivery.attempts ?? 0) + 1;
    try {
        const response = await deps.fetchImpl(sub.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-GTD-Event': delivery.event,
                'X-GTD-Delivery-Id': delivery._id,
                'X-GTD-Signature': signature,
            },
            body,
            signal: controller.signal,
        });
        if (response.ok) {
            const nowIso = deps.now().toISOString();
            await webhookDeliveriesDAO.markDelivered(delivery._id, nowIso);
            await webhookSubscriptionsDAO.recordSuccess(sub._id, nowIso);
            return { delivered: true, abandoned: false };
        }
        const errorMsg = `non-2xx response: ${response.status} ${response.statusText}`;
        const result = await scheduleRetryOrAbandon(delivery._id, sub._id, attempts, errorMsg, deps.now());
        return { delivered: false, abandoned: result.abandoned };
    } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const result = await scheduleRetryOrAbandon(delivery._id, sub._id, attempts, errorMsg, deps.now());
        return { delivered: false, abandoned: result.abandoned };
    } finally {
        clearTimeout(timeout);
    }
}

async function scheduleRetryOrAbandon(
    deliveryId: string,
    subscriptionId: string,
    attempts: number,
    errorMsg: string,
    now: Date,
): Promise<{ abandoned: boolean }> {
    const retryDelay = RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1] ?? 0;
    const result = await webhookDeliveriesDAO.recordRetry(deliveryId, attempts, MAX_DELIVERY_ATTEMPTS, retryDelay, now, errorMsg);
    if (result.abandoned) {
        // The delivery is permanently abandoned — bump the subscription's failure count and
        // auto-disable if it crosses the threshold.
        await webhookSubscriptionsDAO.recordFailure(subscriptionId, MAX_CONSECUTIVE_FAILURES_BEFORE_DISABLE, now.toISOString());
    }
    return result;
}

/**
 * Runs a single worker tick: claim up to CLAIMS_PER_TICK due deliveries and process them in
 * parallel. Returns the number of deliveries handled (test-only signal).
 */
export async function runWorkerTick(deps: WorkerDeps = {}): Promise<number> {
    const fetchImpl =
        deps.fetchImpl ?? ((input: string, init: RequestInit) => fetch(input, init).then((r) => ({ ok: r.ok, status: r.status, statusText: r.statusText })));
    const now = deps.now ?? (() => new Date());
    const due = await webhookDeliveriesDAO.claimDueDeliveries(now().toISOString(), CLAIMS_PER_TICK);
    if (due.length === 0) {
        return 0;
    }
    await Promise.all(
        due.map(async (delivery) => {
            const sub = await webhookSubscriptionsDAO.findOne({ _id: delivery.subscriptionId });
            if (!sub) {
                // Subscription was deleted while a delivery was queued. Mark abandoned so the row
                // doesn't sit in the queue forever; deliveries pre-deletion are tracked in the audit log.
                await webhookDeliveriesDAO.markDelivered(delivery._id, now().toISOString());
                return;
            }
            await deliverOne(delivery, sub, { fetchImpl, now });
        }),
    );
    return due.length;
}

let timer: NodeJS.Timeout | null = null;

/** Starts the recurring tick. Idempotent — calling twice is a no-op. */
export function startWebhookDeliveryWorker(deps: WorkerDeps = {}): void {
    if (timer) {
        return;
    }
    timer = setInterval(() => {
        void runWorkerTick(deps).catch((err) => {
            console.error('[webhooks] worker tick failed', err);
        });
    }, WORKER_TICK_INTERVAL_MS);
    timer.unref?.();
}

/** Stops the worker. Used in tests to avoid the leak between Vitest files. */
export function stopWebhookDeliveryWorker(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}
