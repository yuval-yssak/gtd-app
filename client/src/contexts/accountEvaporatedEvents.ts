import dayjs from 'dayjs';

/**
 * Signals that an account's local rows were evaporated (the account was deleted server-side — see
 * `db/evaporateUser.ts`). Two channels, like `accountReauthEvents.ts`:
 *   - a window event for THIS tab (AppDataProvider drops the account from its list / reloads);
 *   - a `storage` broadcast for every OTHER tab, which may have missed the SSE message (frozen
 *     web view) or never probed the account (tab A already removed it from IDB, so tab B's
 *     `getLoggedInUserIds` no longer lists it) — without it, tab B keeps rendering the deleted
 *     account and queueing orphan ops forever.
 * Own module so the sync layer can dispatch without importing React.
 */
export const ACCOUNT_EVAPORATED_EVENT = 'gtd:account-evaporated';
export const ACCOUNT_EVAPORATED_STORAGE_KEY = 'gtd:accountEvaporated';

export interface AccountEvaporatedDetail {
    userId: string;
}

/** Fires the same-tab evaporated event. No-op outside a browser (Node test env / service worker). */
export function dispatchAccountEvaporated(userId: string): void {
    if (typeof window === 'undefined') {
        return;
    }
    window.dispatchEvent(new CustomEvent<AccountEvaporatedDetail>(ACCOUNT_EVAPORATED_EVENT, { detail: { userId } }));
}

/** Tells every OTHER tab about the evaporation (the `storage` event never fires in the writer). Best-effort. */
export function broadcastAccountEvaporated(userId: string): void {
    if (typeof localStorage === 'undefined') {
        return; // Node test env / SW — nothing to broadcast to
    }
    try {
        // Unique payload per write — the storage event only fires when the stored value changes.
        localStorage.setItem(ACCOUNT_EVAPORATED_STORAGE_KEY, JSON.stringify({ userId, ts: dayjs().valueOf() }));
    } catch {
        // Storage unavailable/full (Safari private mode) — the broadcast must never break the wipe.
    }
}

/**
 * Pure receive side of the broadcast: the evaporated userId carried by a `storage` event's
 * `(key, newValue)`, or null when the event is for another key or the payload is malformed.
 */
export function parseEvaporationBroadcast(key: string | null, newValue: string | null): string | null {
    if (key !== ACCOUNT_EVAPORATED_STORAGE_KEY || !newValue) {
        return null;
    }
    try {
        const parsed: unknown = JSON.parse(newValue);
        if (typeof parsed !== 'object' || parsed === null || !('userId' in parsed)) {
            return null;
        }
        const { userId } = parsed;
        return typeof userId === 'string' && userId.length > 0 ? userId : null;
    } catch {
        return null;
    }
}

/** Subscribes to cross-tab evaporation broadcasts. Returns the unsubscribe function. */
export function subscribeToEvaporationBroadcast(onEvaporated: (userId: string) => void): () => void {
    const onStorage = (event: StorageEvent) => {
        const userId = parseEvaporationBroadcast(event.key, event.newValue);
        if (userId !== null) {
            onEvaporated(userId);
        }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
}
