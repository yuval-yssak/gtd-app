import { useSyncExternalStore } from 'react';

// useSyncExternalStore ensures React re-renders on online/offline events without stale closure issues
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
        () => navigator.onLine,
    );
}
