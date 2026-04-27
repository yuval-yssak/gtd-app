import { API_SERVER } from '../constants/globals';

// Module-level singleton — only one SSE connection per page, shared across all components
let eventSource: EventSource | null = null;

type OnUpdateCallback = () => void;

/**
 * Opens an SSE connection. When `localDeviceId` is provided, events whose
 * `sourceDeviceId` matches are ignored — they originated from this device's
 * own push and would otherwise trigger a redundant sync cycle.
 */
export function openSseConnection(onUpdate: OnUpdateCallback, localDeviceId?: string): void {
    closeSseConnection();

    // withCredentials is required so the auth cookie is sent cross-origin in production
    eventSource = new EventSource(`${API_SERVER}/sync/events`, { withCredentials: true });

    eventSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data as string) as { type?: string; sourceDeviceId?: string };
            console.log('[debug-gcal-sync][client] sse onmessage', data);
            if (data.type !== 'update') {
                return;
            }
            // Skip events that originated from this device's own push
            if (localDeviceId && data.sourceDeviceId === localDeviceId) {
                console.log('[debug-gcal-sync][client] sse ignoring own echo', { localDeviceId, sourceDeviceId: data.sourceDeviceId });
                return;
            }
            console.log('[debug-gcal-sync][client] sse calling onUpdate');
            onUpdate();
        } catch (err) {
            console.warn('[debug-gcal-sync][client] sse malformed event', err, event.data);
        }
    };

    eventSource.onopen = () => {
        console.log('[debug-gcal-sync][client] sse connection open');
    };
    eventSource.onerror = (err) => {
        console.warn('[debug-gcal-sync][client] sse connection error (EventSource will auto-reconnect)', err, 'readyState=', eventSource?.readyState);
    };
}

export function closeSseConnection(): void {
    if (eventSource) {
        eventSource.close();
        eventSource = null;
    }
}
