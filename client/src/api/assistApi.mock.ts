import { vi } from 'vitest';
import type * as actual from './assistApi.ts';

// Resolved instead of the real assistApi in test runs via the "test" condition in package.json
// imports. Re-exports the types + AssistApiError class so tests can build typed proposals and
// construct coded rejections.
export type { AppliedResult, AssistErrorCode, ClarifyProposal, ProposableItemField, ProposedItemPatch, ProposedSideEffect } from './assistApi.ts';
export { AssistApiError } from './assistApi.ts';

export const assist: typeof actual.assist = vi.fn();
export const applyProposal: typeof actual.applyProposal = vi.fn();
