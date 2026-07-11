import { vi } from 'vitest';
import type * as actual from './syncClient.ts';

// Re-exported as-is (not mocked) — it's a plain error class, not a network call, and tests need to
// construct real instances to simulate a 401 (e.g. `mockRejectedValueOnce(new SyncAuthError(...))`).
// Imported from its own module rather than from syncClient.ts: re-exporting a value from the real
// module being mocked pulls its runtime code into the mock's module graph and wedges Vitest's
// module resolution across the whole suite (observed as every worker hanging with near-zero CPU).
export { BootstrapRequiredError } from './bootstrapRequiredError';
export { SyncAuthError } from './syncAuthError';

// Automatically resolved instead of the real syncClient in test runs via the "test"
// condition in package.json imports. Each export matches the real function's type so
// vi.mocked() calls in tests remain fully type-safe.
export const pushSyncOps: typeof actual.pushSyncOps = vi.fn().mockResolvedValue(undefined);
export const fetchBootstrap: typeof actual.fetchBootstrap = vi.fn();
export const fetchSyncOps: typeof actual.fetchSyncOps = vi.fn();
// Defaults to "registered" so pre-existing sync tests never trip the reaped-device recovery path.
export const fetchDeviceStatus: typeof actual.fetchDeviceStatus = vi.fn().mockResolvedValue({ registered: true });
export const fetchVapidConfig: typeof actual.fetchVapidConfig = vi.fn().mockResolvedValue({ vapidPublicKey: null });
export const registerPushEndpoint: typeof actual.registerPushEndpoint = vi.fn().mockResolvedValue(undefined);
