import webPush from 'web-push';
import pushSubscriptionsDAO from '../dataAccess/pushSubscriptionsDAO.js';
import type { EntitySnapshot, OperationInterface, PushSubscriptionRecord } from '../types/entities.js';

const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT) {
    webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
    console.warn('VAPID keys not configured — Web Push notifications disabled. Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT.');
}

// Exposed so the client can subscribe with the correct key without a DB round-trip
export const vapidPublicKey = VAPID_PUBLIC_KEY ?? null;

export async function sendPushToSubscription(record: PushSubscriptionRecord, payload: object): Promise<void> {
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
        return;
    }
    await webPush.sendNotification({ endpoint: record.endpoint, keys: record.keys }, JSON.stringify(payload));
}

function entityDisplayName(snapshot: EntitySnapshot): string {
    return 'title' in snapshot ? snapshot.title : snapshot.name;
}

/**
 * Sends a Web Push notification to all of a user's subscribed devices, optionally excluding one device.
 * Used to notify devices that aren't connected via SSE (e.g., app is closed).
 */
export async function notifyViaWebPush(userId: string, excludeDeviceId: string | null, ops: OperationInterface[], now: string): Promise<void> {
    const opSummaries = ops.map((op) => ({
        entityType: op.entityType,
        opType: op.opType,
        name: op.snapshot ? entityDisplayName(op.snapshot) : null,
    }));
    console.log(`[push] notifying ${userId} of ${ops.length} ops${excludeDeviceId ? ` (excluding device ${excludeDeviceId})` : ''}`);
    const filter = excludeDeviceId ? { user: userId, _id: { $ne: excludeDeviceId } } : { user: userId };
    const pushSubs = await pushSubscriptionsDAO.findArray(filter);
    console.log(`[push] found ${pushSubs.length} subscriptions for user ${userId}`);
    const pushResults = await Promise.allSettled(pushSubs.map((sub) => sendPushToSubscription(sub, { type: 'update', ts: now, ops: opSummaries })));
    pushResults.forEach((result, i) => {
        if (result.status === 'rejected') {
            console.error(`[push] failed to notify device ${pushSubs[i]?._id}:`, result.reason);
        }
    });
}
