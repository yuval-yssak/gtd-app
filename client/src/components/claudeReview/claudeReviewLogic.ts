import type { AssistErrorCode, ProposedItemPatch } from '../../api/assistApi';

/**
 * Pure logic for the Claude review sheet — error→copy mapping, retryability, and the editable-payload
 * patch builder (§8.1). React-free so it's unit-tested directly (the client test env is node/no-DOM).
 */

/** The fields the inline editor may change in place. Editing ONLY these keeps the patch within the
 * executeToken's authorized target (same field set), so Apply reuses the same token. Editing any
 * OTHER field would change the target → the server rejects it (execute_token_target_mismatch). */
export const EDITABLE_PAYLOAD_FIELDS = ['title', 'notes'] as const;
export type EditablePayloadField = (typeof EDITABLE_PAYLOAD_FIELDS)[number];

export interface ReviewErrorView {
    message: string;
    /** When true, the sheet offers a button that re-runs `assist` (a fresh proposal/token). */
    retryable: boolean;
}

/**
 * Maps a server error code (or a code-less network failure) to user-facing copy + whether re-running
 * assist can recover it. A `undefined` code is a network/proxy failure — retryable.
 */
export function describeError(code: AssistErrorCode | undefined): ReviewErrorView {
    switch (code) {
        case 'daily_spend_cap_reached':
            return { message: "You've reached today's Claude limit. Try again tomorrow.", retryable: false };
        case 'agent_timeout':
            return { message: 'Claude took too long to respond. Try again.', retryable: true };
        case 'agent_error':
            return { message: "Claude couldn't finish the request. Try again.", retryable: true };
        case 'execute_token_expired':
        case 'invalid_execute_token':
        case 'execute_token_target_mismatch':
            return { message: 'This suggestion expired. Re-run Clarify to get a fresh one.', retryable: true };
        case 'not_found':
        case 'item_not_found':
            return { message: 'This item no longer exists.', retryable: false };
        case 'forbidden':
        case 'forbidden_scope':
        case 'unauthorized':
            return { message: 'You are not signed in to the account that owns this item.', retryable: false };
        case 'rate_limited':
            return { message: 'Too many requests. Slow down and try again in a moment.', retryable: true };
        default:
            return { message: "Couldn't reach Claude. Check your connection and try again.", retryable: true };
    }
}

/** Applies an inline edit to one editable-payload field, returning the next patch (immutably). */
export function applyPayloadEdit(patch: ProposedItemPatch, field: EditablePayloadField, value: string): ProposedItemPatch {
    return { ...patch, [field]: value };
}

/**
 * True if the proposal has anything worth applying: a non-empty patch AND at least one appliable,
 * non-skipped side-effect. Drives whether the Apply / Apply-All controls are shown.
 */
export function hasAppliableWork(patch: ProposedItemPatch | undefined, appliableTokenPresent: boolean, skipped: boolean): boolean {
    if (!patch || Object.keys(patch).length === 0) {
        return false;
    }
    return appliableTokenPresent && !skipped;
}
