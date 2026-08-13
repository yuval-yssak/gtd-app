import type { OperationInterface } from '../types/entities.js';
import { buildCalendarProvider } from './buildCalendarProvider.js';
import { maybePushToGCal } from './calendarPushback.js';
import { notifyUserViaSse } from './sseConnections.js';
import { enqueueWebhookDeliveries } from './webhookDeliveryWorker.js';
import { notifyViaWebPush } from './webPush.js';

export interface NotifyChangeOptions {
    /**
     * Device id whose own SSE channel should be skipped. Used by `/sync/push` so the originating
     * tab doesn't double-apply its own write. Public-API callers leave this absent — every device
     * is a candidate for the push.
     */
    excludeDeviceId?: string | null;
    /**
     * Skip the GCal pushback leg. Set by callers whose ops must not create/patch GCal events —
     * today the routine item-seeding paths (`seedTargetRoutineItems` after a reassign, and the
     * routine edit-propagation regen), where the freshly generated items are represented by the
     * routine's master series and a per-item push would mint duplicates. SSE / web push / webhook
     * fan-out still fire so subscribers see the change.
     */
    suppressGCalPushback?: boolean;
}

/**
 * Single fan-out for any persisted operation. Replaces the inline fan-out in `routes/sync.ts`
 * and the per-route `notifyChange` in `routes/v1/items.ts`. Fires:
 *
 *   1. SSE to the user's live tabs (with sourceDeviceId echo-suppression)
 *   2. Web push to the user's other devices (skips the originating device when provided)
 *   3. Google Calendar pushback (best-effort, fire-and-forget)
 *   4. Webhook deliveries — now also for `/sync/push`-driven ops (intentional contract change)
 *
 * Intentionally async-but-fire-and-forget for legs 3+4: a Mongo blip in webhook enqueue or a GCal
 * outage must not fail the originating request, since the operation is already persisted.
 */
export async function notifyChange(op: OperationInterface, opts: NotifyChangeOptions = {}): Promise<void> {
    const excludeDeviceId = opts.excludeDeviceId ?? null;

    // SSE — synchronous in-process broadcast. Source device is echoed back so the originating
    // tab's listener can ignore the change it just pushed.
    notifyUserViaSse(op.user, { type: 'update', ts: op.ts, sourceDeviceId: excludeDeviceId ?? undefined });

    // Web push — awaited so the request doesn't return before subscriptions have at least been
    // contacted. Each delivery is itself best-effort under the hood. A transient throw from the
    // subscription lookup must not abort the caller mid-pipeline (e.g. cross-account reassign,
    // where step A's web-push throw used to leave step B unrun → torn state). Log + continue.
    try {
        await notifyViaWebPush(op.user, excludeDeviceId, [op], op.ts);
    } catch (err) {
        console.error('[notify-change] notifyViaWebPush failed; continuing', { opId: op._id, opType: op.opType, err });
    }

    // GCal pushback — fire-and-forget. A flaky calendar provider must not block the request.
    // Suppressed when the caller has already managed the GCal side-effect inline (today: the
    // cross-account calendar-item reassign in `lib/reassignEntity.ts`).
    if (!opts.suppressGCalPushback) {
        void maybePushToGCal(op, buildCalendarProvider).catch((err) => {
            console.error('[notify-change] gcal pushback failed', { opId: op._id, opType: op.opType, err });
        });
    }

    // Webhook fan-out — fire-and-forget. A Mongo blip enqueueing deliveries should not fail the
    // originating request; the worker will pick up rows on its next tick anyway.
    void enqueueWebhookDeliveries(op).catch((err) => {
        console.error('[notify-change] webhook enqueue failed', { opId: op._id, opType: op.opType, err });
    });
}

/**
 * Batch variant — used by `/sync/push` which receives many ops in a single request and fans out
 * once per op. Loop instead of Promise.all because notifyViaWebPush is itself batch-aware (it
 * dedupes per-device subscription lookup) — chunking the SSE per op preserves ordering.
 */
export async function notifyChanges(ops: OperationInterface[], opts: NotifyChangeOptions = {}): Promise<void> {
    if (!ops.length) {
        return;
    }
    const excludeDeviceId = opts.excludeDeviceId ?? null;

    // SSE: one notification carrying the latest ts is enough — the tab will pull all new ops.
    const userId = ops[0]?.user;
    const latestTs = ops.reduce((max, op) => (op.ts > max ? op.ts : max), ops[0]?.ts ?? '');
    if (userId) {
        notifyUserViaSse(userId, { type: 'update', ts: latestTs, sourceDeviceId: excludeDeviceId ?? undefined });
    }

    // Web push: a single batch call keeps the per-device subscription lookup cheap. A transient
    // throw must not abort the caller mid-pipeline — log + continue (mirrors `notifyChange`).
    if (userId) {
        try {
            await notifyViaWebPush(userId, excludeDeviceId, ops, latestTs);
        } catch (err) {
            const opIds = ops.map((op) => op._id);
            console.error('[notify-change] notifyViaWebPush failed; continuing', { opIds, err });
        }
    }

    // GCal + webhook fan-out per op (each leg is fire-and-forget).
    for (const op of ops) {
        if (!opts.suppressGCalPushback) {
            void maybePushToGCal(op, buildCalendarProvider).catch((err) => {
                console.error('[notify-change] gcal pushback failed', { opId: op._id, opType: op.opType, err });
            });
        }
        void enqueueWebhookDeliveries(op).catch((err) => {
            console.error('[notify-change] webhook enqueue failed', { opId: op._id, opType: op.opType, err });
        });
    }
}
