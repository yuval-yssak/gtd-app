import { API_SERVER } from '../constants/globals';

// Module-level registry — at most one EventSource per logged-in user. Multi-account devices
// open N concurrent SSE channels (`?userId=` per channel), so each account gets live updates
// independently of which session is currently active.
const eventSources = new Map<string, EventSource>();

type OnUpdateCallback = (userId: string) => void;

interface UpdatePayload {
    type?: string;
    sourceDeviceId?: string;
}

/**
 * Opens one SSE connection per provided userId. Each channel hits `/sync/events?userId=<uid>`,
 * which the server validates against the device's multi-session cookie. Calling with the same
 * userIds again is idempotent — existing channels stay open and only new ones are started.
 *
 * `onUpdate` is invoked with the userId of the channel that fired so the caller can scope the
 * follow-up pull to that account instead of re-syncing every account on every event.
 */
export function openSseConnections(onUpdate: OnUpdateCallback, localDeviceId: string | undefined, userIds: string[]): void {
    closeStaleConnections(userIds);
    for (const userId of userIds) {
        if (!eventSources.has(userId)) {
            openSingleChannel(userId, onUpdate, localDeviceId);
        }
    }
}

/** Closes every channel and clears the registry. Called on unmount and when going offline. */
export function closeSseConnections(): void {
    for (const source of eventSources.values()) {
        source.close();
    }
    eventSources.clear();
}

/** Returns the userIds that currently have an open EventSource. Used by the e2e harness. */
export function getOpenSseUserIds(): string[] {
    return Array.from(eventSources.keys());
}

function closeStaleConnections(activeUserIds: string[]): void {
    const next = new Set(activeUserIds);
    for (const [userId, source] of eventSources.entries()) {
        if (!next.has(userId)) {
            source.close();
            eventSources.delete(userId);
        }
    }
}

function openSingleChannel(userId: string, onUpdate: OnUpdateCallback, localDeviceId: string | undefined): void {
    // withCredentials is required so the auth + multi-session cookies are sent cross-origin.
    const url = `${API_SERVER}/sync/events?userId=${encodeURIComponent(userId)}`;
    const source = new EventSource(url, { withCredentials: true });

    source.onmessage = (event) => handleMessage(event, userId, onUpdate, localDeviceId);
    source.onopen = () => console.log(`[debug-gcal-sync][client] sse open | userId=${userId}`);
    // EventSource auto-reconnects on transient errors; we only log so we can spot a wedged connection.
    source.onerror = (err) => console.warn(`[debug-gcal-sync][client] sse error | userId=${userId} readyState=${source.readyState}`, err);

    eventSources.set(userId, source);
}

function handleMessage(event: MessageEvent, userId: string, onUpdate: OnUpdateCallback, localDeviceId: string | undefined): void {
    try {
        const data = JSON.parse(event.data as string) as UpdatePayload;
        console.log('[debug-gcal-sync][client] sse onmessage', { userId, data });
        if (data.type !== 'update') {
            return;
        }
        if (localDeviceId && data.sourceDeviceId === localDeviceId) {
            console.log('[debug-gcal-sync][client] sse ignoring own echo', { userId, localDeviceId });
            return;
        }
        onUpdate(userId);
    } catch (err) {
        console.warn('[debug-gcal-sync][client] sse malformed event', err, event.data);
    }
}
