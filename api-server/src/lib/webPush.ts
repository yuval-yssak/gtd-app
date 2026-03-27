import webPush from 'web-push';
import type { PushSubscriptionRecord } from '../types/entities.js';

const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT) {
    webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
    console.warn('VAPID keys not configured — Web Push notifications disabled. Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT.');
}

// Exposed so the client can subscribe with the correct key without a DB round-trip
export const vapidPublicKey = VAPID_PUBLIC_KEY ?? null;

export async function sendPushToSubscription(record: PushSubscriptionRecord, payload: object): Promise<void> {
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
    await webPush.sendNotification({ endpoint: record.endpoint, keys: record.keys }, JSON.stringify(payload));
}
