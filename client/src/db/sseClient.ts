import { API_SERVER } from '../constants/globals';

// Module-level singleton — only one SSE connection per page, shared across all components
let eventSource: EventSource | null = null;

type OnUpdateCallback = () => void;

export function openSseConnection(onUpdate: OnUpdateCallback): void {
    closeSseConnection();

    // withCredentials is required so the auth cookie is sent cross-origin in production
    eventSource = new EventSource(`${API_SERVER}/sync/events`, { withCredentials: true });

    eventSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data as string) as { type?: string };
            if (data.type === 'update') onUpdate();
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
