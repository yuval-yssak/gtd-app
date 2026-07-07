/**
 * Module-level store for which signed-in accounts the user has toggled out of the unified view.
 * Kept here (not in component state) for the same reason as `accountReauthEvents.ts`: the toggle
 * row renders once per AppNav drawer variant plus once in the mobile AppBar, and per-component
 * state would diverge across those mounts. A single shared store keeps every toggle instance and
 * the AppDataProvider filter consistent.
 *
 * Hiding is display-only: sync keeps running for hidden accounts and mutations still write under
 * the active account. The set is persisted to localStorage so it survives reloads.
 */
const STORAGE_KEY = 'gtd:hiddenAccountIds';

function readPersistedHiddenIds(): string[] {
    if (typeof localStorage === 'undefined') {
        return []; // Node test env / SW — no localStorage to read
    }
    try {
        const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
        return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
    } catch {
        return []; // corrupted value — treat as "nothing hidden" rather than throw at module load
    }
}

// Cached snapshot — useSyncExternalStore requires getSnapshot to return a referentially stable
// value between notifications, so the array is only replaced on an actual toggle.
let hiddenSnapshot: string[] = readPersistedHiddenIds();
const listeners = new Set<() => void>();

function persistAndNotify(next: string[]): void {
    hiddenSnapshot = next;
    if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    }
    for (const notify of listeners) {
        notify();
    }
}

/** Flips visibility for `userId`'s data: hidden ⇄ shown. Persists across reloads. */
export function toggleAccountHidden(userId: string): void {
    const next = hiddenSnapshot.includes(userId) ? hiddenSnapshot.filter((id) => id !== userId) : [...hiddenSnapshot, userId];
    persistAndNotify(next);
}

/** useSyncExternalStore subscribe — registers a re-render callback, returns the unsubscribe. */
export function subscribeHiddenAccounts(onChange: () => void): () => void {
    listeners.add(onChange);
    return () => {
        listeners.delete(onChange);
    };
}

/** useSyncExternalStore getSnapshot — userIds currently toggled out of view. */
export function getHiddenAccountIds(): string[] {
    return hiddenSnapshot;
}

/**
 * Drops entities owned by a hidden account. Returns the input array untouched (same reference)
 * when nothing is hidden, so downstream memos don't re-fire on devices that never use the toggle.
 */
export function filterOutHiddenAccounts<T extends { userId: string }>(entities: T[], hiddenUserIds: string[]): T[] {
    if (hiddenUserIds.length === 0) {
        return entities;
    }
    const hidden = new Set(hiddenUserIds);
    return entities.filter((entity) => !hidden.has(entity.userId));
}

/**
 * Bridges the native cross-tab `storage` event into the shared store so a toggle in one tab
 * updates other open tabs. Installed once (guarded), regardless of how many toggle rows mount.
 * No-op outside a browser (Node test env / SW).
 */
let bridgeInstalled = false;
export function ensureHiddenAccountsCrossTabBridge(): void {
    if (bridgeInstalled || typeof window === 'undefined') {
        return;
    }
    bridgeInstalled = true;
    window.addEventListener('storage', (event) => {
        if (event.key !== STORAGE_KEY) {
            return;
        }
        hiddenSnapshot = readPersistedHiddenIds();
        for (const notify of listeners) {
            notify();
        }
    });
}

/** Test-only: clears the shared store (and its persisted key) between cases. */
export function resetHiddenAccountsStore(): void {
    hiddenSnapshot = [];
    if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(STORAGE_KEY);
    }
}
