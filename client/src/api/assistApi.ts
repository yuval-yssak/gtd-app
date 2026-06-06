import { API_SERVER } from '../constants/globals';
import type { EnergyLevel } from '../types/MyDB';

/**
 * HTTP wrapper for the Lane A "Clarify with Claude" endpoints (`/v1/claude/assist[/apply]`, issue
 * #21). Mirrors `tokensApi.ts`: a first-party `credentials: 'include'` fetch (the assist routes are
 * dual-auth and accept the Better Auth session cookie) plus a typed error class that surfaces the
 * server's `code` so the review UI can branch on spend-cap / expired-token / timeout / etc.
 *
 * The proposal types below MIRROR the server's `proposalSchema.ts` — kept here so the client doesn't
 * import server code. Keep them a strict mirror of `ProposableItemField` / `ProposedItemPatch`.
 */

type ItemStatus = 'inbox' | 'nextAction' | 'calendar' | 'waitingFor' | 'somedayMaybe' | 'done' | 'trash';

/** The item fields the clarify agent may propose changing (mirror of server PROPOSABLE_ITEM_FIELDS). */
export type ProposableItemField =
    | 'title'
    | 'notes'
    | 'status'
    | 'workContextIds'
    | 'peopleIds'
    | 'waitingForPersonId'
    | 'energy'
    | 'time'
    | 'focus'
    | 'urgent'
    | 'expectedBy'
    | 'ignoreBefore'
    | 'timeStart'
    | 'timeEnd'
    | 'allDay';

/** A proposed change to the clarified item — all fields optional (the model proposes only what it changes). */
export interface ProposedItemPatch {
    title?: string;
    notes?: string;
    status?: ItemStatus;
    workContextIds?: string[];
    peopleIds?: string[];
    waitingForPersonId?: string;
    energy?: EnergyLevel;
    time?: number;
    focus?: boolean;
    urgent?: boolean;
    expectedBy?: string;
    ignoreBefore?: string;
    timeStart?: string;
    timeEnd?: string;
    allDay?: boolean;
}

/** A proposed side-effect the user can apply, edit, or skip. Only the token-bearing one is appliable. */
export interface ProposedSideEffect {
    kind: 'itemPatch';
    preview: string;
    executeToken?: string;
}

export interface ClarifyProposal {
    summary: string;
    proposedItemPatch?: ProposedItemPatch;
    proposedSideEffects: ProposedSideEffect[];
}

/** The apply endpoint's success shape. */
export interface AppliedResult {
    applied: true;
    item: { id: string; status: ItemStatus; title: string };
}

/**
 * The server error `code`s the review UI branches on. `undefined` covers a network failure or a
 * non-JSON body (offline, proxy error) — the UI treats those as a generic retryable error.
 */
export type AssistErrorCode =
    | 'invalid_request'
    | 'not_found'
    | 'item_not_found'
    | 'daily_spend_cap_reached'
    | 'agent_timeout'
    | 'agent_error'
    | 'execute_token_expired'
    | 'invalid_execute_token'
    | 'execute_token_target_mismatch'
    | 'forbidden'
    | 'forbidden_scope'
    | 'invalid_operation'
    | 'unauthorized'
    | 'rate_limited';

interface ErrorBody {
    error?: string;
    code?: AssistErrorCode;
}

/** Surfaces the server's `code` (and HTTP status) so callers can branch on errors like the spend cap. */
export class AssistApiError extends Error {
    readonly status: number;
    readonly code: AssistErrorCode | undefined;
    constructor(status: number, message: string, code: AssistErrorCode | undefined) {
        super(message);
        this.name = 'AssistApiError';
        this.status = status;
        this.code = code;
    }
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
    // credentials: 'include' — the Better Auth session cookie travels cross-origin (client ≠ API domain).
    const response = await fetch(`${API_SERVER}${path}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const errorBody = (await response.json().catch(() => ({}))) as ErrorBody;
        throw new AssistApiError(response.status, errorBody.error ?? `assist API error ${response.status}`, errorBody.code);
    }
    return (await response.json()) as T;
}

/** Runs the clarify loop for an item and returns the reviewable proposal. */
export async function assist(itemId: string, instruction?: string): Promise<ClarifyProposal> {
    return postJson<ClarifyProposal>('/v1/claude/assist', { itemId, ...(instruction ? { instruction } : {}) });
}

/** Redeems an executeToken with the (possibly edited) patch, applying the approved write server-side. */
export async function applyProposal(executeToken: string, patch: ProposedItemPatch): Promise<AppliedResult> {
    return postJson<AppliedResult>('/v1/claude/assist/apply', { executeToken, patch });
}
