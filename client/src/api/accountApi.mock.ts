import { vi } from 'vitest';
import type * as actual from './accountApi.ts';

// Plain error class + pure helpers — re-exported from the real module so tests can use real instances.
export { AccountApiError, exportFilenameFromHeader, SESSION_MISMATCH_CODE } from './accountApi.ts';

// Resolved instead of the real accountApi in test runs via the "test" condition in package.json
// imports. Defaults to "active" so the tombstone check in syncAllLoggedInUsers is a pass-through
// for every existing sync test; evaporation tests override it per case.
export const fetchUserStatus: typeof actual.fetchUserStatus = vi.fn().mockResolvedValue({ status: 'active' });
export const deleteMyAccount: typeof actual.deleteMyAccount = vi.fn();
export const downloadMyData: typeof actual.downloadMyData = vi.fn().mockResolvedValue(undefined);
