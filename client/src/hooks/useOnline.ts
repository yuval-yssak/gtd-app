import { useSyncExternalStore } from 'react';
import { isBrowserOffline } from '../lib/onlineStatus';

// useSyncExternalStore ensures React re-renders on online/offline events without stale closure issues.
// Expressed via isBrowserOffline so the reactive hook and the imperative probe (lib/onlineStatus.ts)
// can never disagree on what counts as offline.
export function useOnline() {
    return useSyncExternalStore(
        (cb) => {
            window.addEventListener('online', cb);
            window.addEventListener('offline', cb);
            return () => {
                window.removeEventListener('online', cb);
                window.removeEventListener('offline', cb);
            };
        },
        () => !isBrowserOffline(),
    );
}
