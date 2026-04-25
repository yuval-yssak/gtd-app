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
            console.log('[sse] received update event', data);
            if (data.type !== 'update') {
                return;
            }
            // Skip events that originated from this device's own push
            if (localDeviceId && data.sourceDeviceId === localDeviceId) {
                console.log('[sse] ignoring own echo');
                return;
            }
            onUpdate();
        } catch {
            // Malformed event — ignore; EventSource will stay open
        }
    };

    // EventSource reconnects automatically on error; no manual retry needed
}

export function closeSseConnection(): void {
    if (eventSource) {
        eventSource.close();
        eventSource = null;
    }
}
