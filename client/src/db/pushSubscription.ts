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
    const existing = await registration.pushManager.getSubscription();

    if (existing) {
        if (vapidKeyMatchesSubscription(existing, vapidPublicKey)) {
            return existing;
        }
        // VAPID key has rotated (e.g. staging redeploy) — the existing subscription's auth
        // was negotiated with the old key so the server can no longer authenticate pushes.
        // Unsubscribe first; subscribe() below will create a fresh subscription.
        await existing.unsubscribe();
    }

    return registration.pushManager.subscribe({
        userVisibleOnly: true,
        // PushManager requires a Uint8Array, not a base64 string.
        // `Uint8Array.from` returns `Uint8Array<ArrayBufferLike>` but the API expects
        // `ArrayBufferView<ArrayBuffer>` — safe cast because the buffer is always a plain ArrayBuffer.
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
    });
}

// Compare the key bytes stored on the existing subscription against the current VAPID public key.
// PushSubscription.options.applicationServerKey is an ArrayBuffer set when subscribe() was called.
function vapidKeyMatchesSubscription(subscription: PushSubscription, vapidPublicKey: string): boolean {
    const stored = subscription.options.applicationServerKey;
    if (!stored) return false; // subscription predates applicationServerKey support — treat as stale
    const current = urlBase64ToUint8Array(vapidPublicKey);
    const storedBytes = new Uint8Array(stored);
    return storedBytes.length === current.length && storedBytes.every((b, i) => b === current[i]);
}

// The VAPID public key is URL-safe base64; the browser PushManager requires a Uint8Array.
function urlBase64ToUint8Array(base64: string): Uint8Array {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from([...atob(normalized)].map((c) => c.charCodeAt(0)));
}
