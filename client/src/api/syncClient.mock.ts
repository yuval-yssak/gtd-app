import { vi } from 'vitest';
import type * as actual from './syncClient.ts';

// Automatically resolved instead of the real syncClient in test runs via the "test"
// condition in package.json imports. Each export matches the real function's type so
// vi.mocked() calls in tests remain fully type-safe.
export const pushSyncOps: typeof actual.pushSyncOps = vi.fn().mockResolvedValue(undefined);
export const fetchBootstrap: typeof actual.fetchBootstrap = vi.fn();
export const fetchSyncOps: typeof actual.fetchSyncOps = vi.fn();
export const fetchVapidConfig: typeof actual.fetchVapidConfig = vi.fn().mockResolvedValue({ vapidPublicKey: null });
export const registerPushEndpoint: typeof actual.registerPushEndpoint = vi.fn().mockResolvedValue(undefined);
