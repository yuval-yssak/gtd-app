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
//
// Check the existing state first: calling requestPermission() when already 'granted' or
// 'denied' is a no-op on desktop, but mobile browsers (iOS Safari, some Android) may
// re-show the dialog or behave erratically, causing the user to dismiss it and leaving
// permission as 'default', which makes this function return false on every reload.
async function hasNotificationPermission(): Promise<boolean> {
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
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
