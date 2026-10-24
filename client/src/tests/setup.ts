// fake-indexeddb/auto registers globalThis.indexedDB AND all IDB class globals
// (IDBRequest, IDBTransaction, IDBKeyRange, etc.) that the `idb` library references
// via instanceof checks. Importing just IDBFactory and setting indexedDB is not enough.
import 'fake-indexeddb/auto';

// queueSyncOp checks `'serviceWorker' in navigator` before registering a background sync.
// Providing a navigator without the serviceWorker key makes that condition false,
// short-circuiting before any reference to ServiceWorkerRegistration (which doesn't exist in Node).
// Node only: jsdom files (`// @vitest-environment jsdom`) keep jsdom's own navigator, which
// already has no serviceWorker and which react-dom reads (`navigator.userAgent`) at load.
const isJsdom = typeof window !== 'undefined' && window.navigator.userAgent.includes('jsdom');
if (!isJsdom) {
    Object.defineProperty(globalThis, 'navigator', {
        // userAgent/platform: Base UI reads them at import time (platform detection), and node tests
        // reach Base UI transitively through any module that imports the design system.
        value: { onLine: true, userAgent: 'node', platform: '' },
        configurable: true,
        writable: true,
    });
}
