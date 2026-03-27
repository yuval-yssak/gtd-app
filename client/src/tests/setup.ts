// fake-indexeddb/auto registers globalThis.indexedDB AND all IDB class globals
// (IDBRequest, IDBTransaction, IDBKeyRange, etc.) that the `idb` library references
// via instanceof checks. Importing just IDBFactory and setting indexedDB is not enough.
import 'fake-indexeddb/auto';

// queueSyncOp checks `'serviceWorker' in navigator` before registering a background sync.
// Providing a navigator without the serviceWorker key makes that condition false,
// short-circuiting before any reference to ServiceWorkerRegistration (which doesn't exist in Node).
Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: true },
    configurable: true,
    writable: true,
});
