import type { IDBPDatabase } from 'idb';
import { fetchVapidConfig, registerPushEndpoint } from '#api/syncClient';
import type { MyDB } from '../types/MyDB';
import { getOrCreateDeviceId } from './deviceId';

// Silent path — only registers if permission is already granted.
// Safe to call on mount without a user gesture.
export async function registerPushSubscriptionIfPermitted(db: IDBPDatabase<MyDB>): Promise<void> {
    if (!isBrowserPushCapable()) return;
    if (Notification.permission !== 'granted') return;
    await doRegister(db);
}

// Explicit path — requests permission if not yet granted, then registers.
// MUST be called from a user gesture (button click): calling requestPermission() outside
// a gesture triggers Chrome's "quiet notification UI" (a silent bell icon in the address bar)
// which users routinely dismiss, leaving permission permanently as 'default'.
// Returns true if permission was granted and the subscription was registered successfully.
export async function requestAndRegisterPushSubscription(db: IDBPDatabase<MyDB>): Promise<boolean> {
    if (!isBrowserPushCapable()) return false;
    if (Notification.permission === 'denied') return false;

    if (Notification.permission === 'default') {
        // Check again before calling to avoid re-showing the dialog on mobile browsers
        // (iOS Safari, some Android) which may behave erratically if called when not 'default'.
        await Notification.requestPermission();
    }

    if (Notification.permission !== 'granted') return false;

    await doRegister(db);
    return true;
}

function isBrowserPushCapable(): boolean {
    return 'serviceWorker' in navigator && 'PushManager' in window;
}

async function doRegister(db: IDBPDatabase<MyDB>): Promise<void> {
    const { vapidPublicKey } = await fetchVapidConfig();
    if (!vapidPublicKey) {
        return; // server has no VAPID keys configured (or request failed — fetchVapidConfig degrades gracefully)
    }

    const subscription = await getOrCreatePushSubscription(vapidPublicKey);
    const deviceId = await getOrCreateDeviceId(db);
    await registerPushEndpoint(deviceId, subscription.toJSON());
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
