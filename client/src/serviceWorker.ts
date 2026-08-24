/// <reference lib="webworker" />

import { clientsClaim } from 'workbox-core';
import { createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { BootstrapRequiredError, SyncAuthError } from './api/syncClient';
import { fetchSessionUserId, flushQueueForSessionUser, pullForSessionUser } from './db/backgroundSync';
// withAppDB (not a bare openAppDB) — the SW outlives individual events, and a connection left
// open here holds the schema version and blocks the next upgrade in every tab.
import { withAppDB } from './db/indexedDB';
import { hasAtLeastOne } from './lib/typeUtils';

/** Posted to open tabs so they can call `dispatchAccountNeedsReauth` — the SW has no `window` to dispatch on directly. */
interface AccountNeedsReauthMessage {
    type: 'account-needs-reauth';
    userId: string;
}

async function notifyClientsAccountNeedsReauth(userId: string): Promise<void> {
    const clients = await self.clients.matchAll({ type: 'window' });
    const message: AccountNeedsReauthMessage = { type: 'account-needs-reauth', userId };
    for (const client of clients) {
        client.postMessage(message);
    }
}

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
    syncEvent.waitUntil(
        withAppDB(async (db) => {
            // Session-scoped, NOT IDB-scoped: after an offline account switch the cookie can still
            // point at the previous account until a foreground tab runs the cookie reconcile. An
            // unscoped flush here would push the new account's queued ops under the old session —
            // and `snapshot: null` delete ops bypass /sync/push's misroute guard, so that would be
            // silent cross-account misattribution, not just a rejected batch. Scoping to whoever
            // the cookie authenticates as makes this flush correct regardless of IDB drift; the
            // other account's ops flush on the next foreground pass after the reconcile.
            const sessionUserId = await fetchSessionUserId();
            if (!sessionUserId) {
                return; // no reachable/valid session — defer to the next foreground pass
            }
            try {
                await flushQueueForSessionUser(db, async () => sessionUserId);
            } catch (err) {
                if (err instanceof SyncAuthError) {
                    await notifyClientsAccountNeedsReauth(sessionUserId);
                    return;
                }
                throw err;
            }
        }),
    );
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

    console.log('[sw-push] received push notification', payload);

    event.waitUntil(
        // Per-user cursors require a userId on every pull. The SW can't pivot Better Auth
        // sessions (the auth client is React-only), so the pull is scoped to whoever the
        // cookie authenticates as — and ONLY when that agrees with IDB's activeAccount
        // (pullForSessionUser skips on drift, e.g. an offline account switch not yet
        // reconciled; pulling in that window would land the cookie-user's ops under the
        // IDB-user's cursor). Other logged-in accounts catch up at the next foreground sync.
        withAppDB(async (db) => {
            const sessionUserId = await fetchSessionUserId();
            if (!sessionUserId) return;
            try {
                await pullForSessionUser(db, async () => sessionUserId);
            } catch (err) {
                if (err instanceof SyncAuthError) {
                    await notifyClientsAccountNeedsReauth(sessionUserId);
                    return;
                }
                if (err instanceof BootstrapRequiredError) {
                    // The SW can't show the recovery dialog. Swallow — the next foreground sync
                    // (syncOneUser) detects the reaped device and runs the recovery flow there.
                    console.log('[sw-push] pull requires full bootstrap — deferring recovery to the next foreground sync');
                    return;
                }
                throw err;
            }
        })
            .then(() => {
                console.log('[sw-push] pulled from server, notifying open tabs');
                // Notify any open tabs so they can refresh React state from IndexedDB —
                // without this, the tab only sees the updated data after the next mount.
                return self.clients.matchAll({ type: 'window' });
            })
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
