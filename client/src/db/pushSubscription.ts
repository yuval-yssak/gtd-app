import type { IDBPDatabase } from 'idb';
import type { MyDB } from '../types/MyDB';
import { getOrCreateDeviceId } from './deviceId';

export async function registerPushSubscription(db: IDBPDatabase<MyDB>): Promise<void> {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

    // Fetch the VAPID public key from the server — it's public so no auth needed
    const res = await fetch('/sync/config', { credentials: 'include' });
    if (!res.ok) return;
    const { vapidPublicKey } = (await res.json()) as { vapidPublicKey: string | null };
    if (!vapidPublicKey) return; // server has no VAPID keys configured

    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const subscription = existing ?? (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        // PushManager requires the VAPID key as a Uint8Array, not a base64 string
        // `Uint8Array.from` returns `Uint8Array<ArrayBufferLike>` but the API expects
        // `ArrayBufferView<ArrayBuffer>` — safe cast because the buffer is always a plain ArrayBuffer
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
    }));

    const deviceId = await getOrCreateDeviceId(db);
    const json = subscription.toJSON();
    await fetch('/push/subscribe', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, endpoint: json.endpoint, keys: json.keys }),
    });
}

// The VAPID public key is URL-safe base64; the browser PushManager requires a Uint8Array.
function urlBase64ToUint8Array(base64: string): Uint8Array {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from([...atob(normalized)].map((c) => c.charCodeAt(0)));
}
