import webPush from 'web-push';
import deviceUsersDAO from '../dataAccess/deviceUsersDAO.js';
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
 * Resolve every device that should receive a push for `userId` by joining `deviceUsers`
 * (the source of truth for which device hosts which Better Auth session) with
 * `pushSubscriptions` (the actual VAPID-keyed endpoint per device). A device only gets
 * a push if it has BOTH a current join row AND a current subscription row.
 */
async function findSubscribedDevicesForUser(userId: string, excludeDeviceId: string | null): Promise<PushSubscriptionRecord[]> {
    const joins = await deviceUsersDAO.findDevicesByUser(userId);
    const targetDeviceIds = joins.map((j) => j.deviceId).filter((id) => id !== excludeDeviceId);
    if (!targetDeviceIds.length) {
        return [];
    }
    return pushSubscriptionsDAO.findArray({ _id: { $in: targetDeviceIds } } as never);
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
    const pushSubs = await findSubscribedDevicesForUser(userId, excludeDeviceId);
    console.log(`[push] found ${pushSubs.length} subscriptions for user ${userId}`);
    const pushResults = await Promise.allSettled(pushSubs.map((sub) => sendPushToSubscription(sub, { type: 'update', ts: now, ops: opSummaries })));
    const cleanupPromises: Promise<void>[] = [];
    pushResults.forEach((result, i) => {
        const sub = pushSubs[i];
        if (result.status !== 'rejected' || !sub) {
            return;
        }

        const statusCode = (result.reason as { statusCode?: number })?.statusCode;
        if (statusCode === 410 || statusCode === 404) {
            console.log(`[push] subscription gone for device ${sub._id} (${statusCode}), removing`);
            // The device has lost its push registration entirely — drop the subscription row
            // and every (device, user) join row so subsequent fan-outs don't target it again.
            cleanupPromises.push(
                pushSubscriptionsDAO.deleteByDevice(sub._id, userId).catch((e) => {
                    console.error(`[push] failed to delete stale subscription ${sub._id}:`, e);
                }),
                deviceUsersDAO.removeAllForDevice(sub._id).catch((e) => {
                    console.error(`[push] failed to delete deviceUsers rows for ${sub._id}:`, e);
                }),
            );
        } else {
            console.error(`[push] failed to notify device ${sub._id}:`, result.reason);
        }
    });
    // Fire-and-forget cleanup — don't block the caller
    void Promise.all(cleanupPromises);
}
