import { API_SERVER } from '../constants/globals';

// Module-level registry — at most one EventSource per logged-in user. Multi-account devices
// open N concurrent SSE channels (`?userId=` per channel), so each account gets live updates
// independently of which session is currently active.
const eventSources = new Map<string, EventSource>();

type OnUpdateCallback = (userId: string) => void;
/** Fired when the server announces that the channel's account was deleted (`{ type: 'account-deleted' }`). */
type OnAccountDeletedCallback = (userId: string) => void;

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
export function openSseConnections(handlers: ChannelHandlers, userIds: string[]): void {
    closeStaleConnections(userIds);
    dropDeadConnections();
    for (const userId of userIds) {
        if (!eventSources.has(userId)) {
            openSingleChannel(userId, handlers);
        }
    }
}

/**
 * Evicts channels whose socket is permanently CLOSED so the reopen loop below re-creates them.
 * Without this, `eventSources.has(userId)` reports a channel as live purely because the entry is
 * still in the Map, and a dead socket is never replaced — the tab silently stops receiving updates
 * until a full reload. iOS hits this every time it freezes a backgrounded PWA's web view and tears
 * the connection down; `onerror` alone can't clean up, since EventSource also reports recoverable
 * (auto-reconnecting) failures through it, which must NOT be evicted.
 */
function dropDeadConnections(): void {
    for (const [userId, source] of eventSources.entries()) {
        if (source.readyState === EventSource.CLOSED) {
            eventSources.delete(userId);
        }
    }
}

/**
 * Force-reopens every channel regardless of readyState. A frozen-then-resumed web view can leave a
 * socket that reports CONNECTING/OPEN but is attached to a connection the OS already dropped, so
 * readyState alone can't prove liveness — on resume we discard unconditionally and reconnect.
 */
export function reopenSseConnections(handlers: ChannelHandlers, userIds: string[]): void {
    closeSseConnections();
    openSseConnections(handlers, userIds);
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

function openSingleChannel(userId: string, handlers: ChannelHandlers): void {
    // withCredentials is required so the auth + multi-session cookies are sent cross-origin.
    const url = `${API_SERVER}/sync/events?userId=${encodeURIComponent(userId)}`;
    const source = new EventSource(url, { withCredentials: true });

    source.onmessage = (event) => handleMessage(event, userId, handlers);
    source.onopen = () => console.log(`[debug-gcal-sync][client] sse open | userId=${userId}`);
    // EventSource auto-reconnects on transient errors; we only log so we can spot a wedged connection.
    source.onerror = (err) => console.warn(`[debug-gcal-sync][client] sse error | userId=${userId} readyState=${source.readyState}`, err);

    eventSources.set(userId, source);
}

/** What a channel does with each server message. One object shared by every channel of a device. */
export interface ChannelHandlers {
    onUpdate: OnUpdateCallback;
    /** This device's id, so the channel can ignore echoes of its own writes. */
    localDeviceId?: string | undefined;
    onAccountDeleted?: OnAccountDeletedCallback | undefined;
}

function handleMessage(event: MessageEvent, userId: string, handlers: ChannelHandlers): void {
    try {
        const data = JSON.parse(event.data as string) as UpdatePayload;
        console.log('[debug-gcal-sync][client] sse onmessage', { userId, data });
        if (data.type === 'account-deleted') {
            handleAccountDeleted(userId, handlers.onAccountDeleted);
            return;
        }
        if (data.type !== 'update') {
            return;
        }
        if (handlers.localDeviceId && data.sourceDeviceId === handlers.localDeviceId) {
            console.log('[debug-gcal-sync][client] sse ignoring own echo', { userId, localDeviceId: handlers.localDeviceId });
            return;
        }
        handlers.onUpdate(userId);
    } catch (err) {
        console.warn('[debug-gcal-sync][client] sse malformed event', err, event.data);
    }
}

/**
 * The server closes the stream right after this message. Drop the channel ourselves too — otherwise
 * EventSource would auto-reconnect against an account that no longer exists and 401 forever.
 */
function handleAccountDeleted(userId: string, onAccountDeleted: OnAccountDeletedCallback | undefined): void {
    eventSources.get(userId)?.close();
    eventSources.delete(userId);
    onAccountDeleted?.(userId);
}
