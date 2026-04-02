/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import { createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { openAppDB } from './db/indexedDB';
import { flushSyncQueue, pullFromServer } from './db/syncHelpers';
import { hasAtLeastOne } from './lib/typeUtils';

declare const self: ServiceWorkerGlobalScope;

// SyncEvent is not in the standard TypeScript DOM lib — define the subset we need
interface SyncEvent extends ExtendableEvent {
    readonly tag: string;
}

// Workbox injects the hashed precache manifest here at build time
precacheAndRoute(self.__WB_MANIFEST);

// Serve the cached index.html for all navigation requests (page loads and refreshes).
// Without this, only exact precache URL matches are served offline — deep-link routes
// like /inbox fall through to the network and show the browser's offline error page.
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html')));

// Take over all open tabs immediately after activation so new code runs right away.
// Matches the previous autoUpdate behaviour.
self.skipWaiting();
clientsClaim();

// ---------------------------------------------------------------------------
// Background Sync — flush the offline queue when connectivity is restored.
// Fires even if the user hasn't reopened the app yet.
// ---------------------------------------------------------------------------
self.addEventListener('sync', (event) => {
    const syncEvent = event as SyncEvent;
    if (syncEvent.tag !== 'gtd-sync-queue') return;
    syncEvent.waitUntil(openAppDB().then((db) => flushSyncQueue(db)));
});

// ---------------------------------------------------------------------------
// Web Push — another device pushed changes while this app was closed.
// Wake up, pull the new ops, and write them to IndexedDB so the next app
// open shows fresh data even if the device is offline again by then.
// Browsers require showNotification() to be called from a push handler;
// omitting it can cause the browser to display a generic fallback notification.
// ---------------------------------------------------------------------------

interface PushOpSummary {
    entityType: string;
    opType: string;
    name: string | null;
}

function opTypeVerb(opType: string): string {
    return opType === 'create' ? 'Added' : opType === 'delete' ? 'Deleted' : 'Updated';
}

function formatOp({ opType, name }: PushOpSummary): string {
    return name ? `${opTypeVerb(opType)}: ${name}` : `${opTypeVerb(opType)} item`;
}

function buildNotificationBody(ops: PushOpSummary[]): string {
    if (!hasAtLeastOne(ops)) {
        return 'Your tasks have been updated from another device.';
    }
    if (ops.length === 1) {
        return formatOp(ops[0]);
    }
    const previews = ops.slice(0, 2).map(formatOp);
    const tail = ops.length > 2 ? ` (+${ops.length - 2} more)` : '';
    return previews.join(' · ') + tail;
}

self.addEventListener('push', (event) => {
    // event.data may be absent if the push was sent without a payload (e.g. older server version)
    const payload = (event.data?.json() as { ops?: PushOpSummary[] } | null) ?? null;

    event.waitUntil(
        openAppDB()
            .then((db) => pullFromServer(db))
            .then(() =>
                // Notify any open tabs so they can refresh React state from IndexedDB —
                // without this, the tab only sees the updated data after the next mount.
                self.clients.matchAll({ type: 'window' }),
            )
            .then((clients) =>
                clients.forEach((c) => {
                    c.postMessage({ type: 'sync-complete' });
                }),
            )
            .then(() =>
                self.registration.showNotification('Getting Things Done', {
                    body: buildNotificationBody(payload?.ops ?? []),
                    icon: '/icon.svg',
                    // Unique tag per push so each notification is shown separately rather than
                    // silently replacing the previous one.
                    tag: `gtd-sync-update${Date.now()}`,
                }),
            ),
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            const existing = clientList.find((c) => c.url.startsWith(self.location.origin));
            // Focus the existing tab if the app is already open; otherwise open a new one
            return existing ? existing.focus() : self.clients.openWindow('/');
        }),
    );
});
