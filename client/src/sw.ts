/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import { createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { openAppDB } from './db/indexedDB';
import { flushSyncQueue, pullFromServer } from './db/syncHelpers';

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
// ---------------------------------------------------------------------------
self.addEventListener('push', (event) => {
    event.waitUntil(openAppDB().then((db) => pullFromServer(db)));
});
