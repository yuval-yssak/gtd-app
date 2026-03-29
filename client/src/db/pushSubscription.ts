import type { IDBPDatabase } from 'idb';
import { fetchVapidConfig, registerPushEndpoint } from '#api/syncClient';
import type { MyDB } from '../types/MyDB';
import { getOrCreateDeviceId } from './deviceId';

export async function registerPushSubscription(db: IDBPDatabase<MyDB>): Promise<void> {
    if (!isBrowserPushCapable()) {
        return;
    }
    if (!(await hasNotificationPermission())) {
        return;
    }

    const { vapidPublicKey } = await fetchVapidConfig();
    if (!vapidPublicKey) {
        return; // server has no VAPID keys configured (or request failed — fetchVapidConfig degrades gracefully)
    }

    const subscription = await getOrCreatePushSubscription(vapidPublicKey);
    const deviceId = await getOrCreateDeviceId(db);
    await registerPushEndpoint(deviceId, subscription.toJSON());
}

function isBrowserPushCapable(): boolean {
    return 'serviceWorker' in navigator && 'PushManager' in window;
}

// Must request permission explicitly — relying on pushManager.subscribe() to do it
// implicitly triggers Chrome's "quiet notification UI" (a small bell icon in the address
// bar rather than a popup), which users routinely miss, leaving permission as 'default'
// and causing subscribe() to fail with NotAllowedError.
async function hasNotificationPermission(): Promise<boolean> {
    return (await Notification.requestPermission()) === 'granted';
}

async function getOrCreatePushSubscription(vapidPublicKey: string): Promise<PushSubscription> {
    const registration = await navigator.serviceWorker.ready;
    return (
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
            userVisibleOnly: true,
            // PushManager requires a Uint8Array, not a base64 string.
            // `Uint8Array.from` returns `Uint8Array<ArrayBufferLike>` but the API expects
            // `ArrayBufferView<ArrayBuffer>` — safe cast because the buffer is always a plain ArrayBuffer.
            applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
        }))
    );
}

// The VAPID public key is URL-safe base64; the browser PushManager requires a Uint8Array.
function urlBase64ToUint8Array(base64: string): Uint8Array {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from([...atob(normalized)].map((c) => c.charCodeAt(0)));
}
