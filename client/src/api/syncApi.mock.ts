import { vi } from 'vitest';
import type * as actual from './syncApi.ts';

// Auto-resolved instead of the real syncApi in test runs via the "test" condition in
// package.json imports. Defaults to a successful no-op response so tests that don't
// care about the response shape still work without a per-test override.
export const reassignEntityOnServer: typeof actual.reassignEntityOnServer = vi.fn().mockResolvedValue({ ok: true });
