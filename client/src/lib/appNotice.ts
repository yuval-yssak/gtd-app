/**
 * A one-line, app-wide notice that outlives the route that raised it — e.g. "Inbox clear!" after the
 * Process Inbox page navigates back to the inbox and unmounts. Module-level (like `undoStore`), shown
 * by the one `AppNoticeToast` the authenticated layout mounts.
 */
export interface AppNotice {
    /** Monotonic, so a toast closing late can only dismiss the notice it was showing. */
    id: number;
    message: string;
}

const store: { current: AppNotice | null; nextId: number } = { current: null, nextId: 1 };
const listeners = new Set<() => void>();

function notify(): void {
    for (const listener of listeners) {
        listener();
    }
}

/** Shows `message`, replacing whatever notice is up. */
export function showAppNotice(message: string): void {
    store.current = { id: store.nextId, message };
    store.nextId += 1;
    notify();
}

/** Clears the notice with this id — a no-op once a newer notice replaced it. */
export function dismissAppNotice(id: number): void {
    if (store.current?.id !== id) {
        return;
    }
    store.current = null;
    notify();
}

export function getAppNotice(): AppNotice | null {
    return store.current;
}

export function subscribeToAppNotice(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Test-only: forget the shown notice and every subscriber. */
export function __resetAppNoticeForTests(): void {
    store.current = null;
    listeners.clear();
}
