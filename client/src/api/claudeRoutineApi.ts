import { API_SERVER } from '../constants/globals';
import type { ClaudeAskOutcome, StoredClaudeAsk } from '../types/MyDB';

/**
 * HTTP wrapper for the session-authed Claude routine endpoints (`/account/claude-routine`):
 * Settings connects / replaces / disconnects the user's Claude routine (a Claude Code cloud
 * routine — not a Done routine), and the item editor's "Ask Claude" box starts it. First-party
 * `credentials: 'include'` fetches — callers pin the session with `withActiveAccountSession`
 * (Settings) or `withOwnerSession(item.userId, …)` (an item), so the call acts as that account.
 */

/** The ask row as the server sends it: wire field `user`, remapped to `userId` when applied locally. */
export type ServerClaudeAskSnapshot = Omit<StoredClaudeAsk, 'userId'> & { user: string };

/** What Settings may see about the stored Claude routine — never the token, only its last 4 characters. */
export interface ClaudeRoutineConnectionView {
    connected: boolean;
    claudeRoutineId?: string | undefined;
    tokenHint?: string | undefined;
    updatedTs?: string | undefined;
}

/** The server error `code`s the UI branches on. `undefined` covers a network failure, a non-JSON body, or an unknown code. */
const CLAUDE_ROUTINE_ERROR_CODES = [
    'invalid_claude_routine_id',
    'invalid_claude_routine_token',
    'invalid_item_id',
    'invalid_prompt',
    'not_found',
    'claude_routine_not_connected',
    'claude_ask_in_flight',
    'claude_routine_token_rejected',
    'claude_routine_not_found',
    'claude_routine_unavailable',
    'claude_routine_rate_limited',
    'claude_routine_unreachable',
    // Client-side only: this device gave up waiting. The server may still have started the session.
    'timeout',
] as const;
export type ClaudeRoutineErrorCode = (typeof CLAUDE_ROUTINE_ERROR_CODES)[number];

function toErrorCode(value: unknown): ClaudeRoutineErrorCode | undefined {
    return CLAUDE_ROUTINE_ERROR_CODES.find((code) => code === value);
}

/**
 * Client deadline, kept below `withSessionGate`'s 10 s escape hatch (`db/syncHelpers.ts`) so a
 * normal slow call ends before the gate gives up. It narrows the cookie-drift window rather than
 * closing it: the gate's timer also covers the session pivot itself, so a call can still finish
 * after the gate released. The server's own upstream budget (7 s) fits inside this one.
 */
const CLAUDE_ROUTINE_TIMEOUT_MS = 8_000;

export class ClaudeRoutineApiError extends Error {
    readonly status: number;
    readonly code: ClaudeRoutineErrorCode | undefined;
    readonly retryAfterSeconds: number | undefined;
    constructor(message: string, failure: { status: number; code?: ClaudeRoutineErrorCode | undefined; retryAfterSeconds?: number | undefined }) {
        super(message);
        this.name = 'ClaudeRoutineApiError';
        this.status = failure.status;
        this.code = failure.code;
        this.retryAfterSeconds = failure.retryAfterSeconds;
    }
}

/**
 * Reads a wire body as an object with only the named keys, each `unknown`. Safe cast: every
 * property stays `unknown` and gets narrowed by the caller, so nothing is trusted from the wire.
 */
function asLooseObject<K extends string>(value: unknown): { [P in K]?: unknown } | undefined {
    return typeof value === 'object' && value !== null ? (value as { [P in K]?: unknown }) : undefined;
}

function readRetryAfterSeconds(response: Response): number | undefined {
    const raw = response.headers.get('Retry-After');
    const seconds = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

async function toApiError(response: Response): Promise<ClaudeRoutineApiError> {
    const body = asLooseObject<'error' | 'code'>(await response.json().catch(() => undefined));
    const message = typeof body?.error === 'string' ? body.error : `Claude routine API error ${response.status}`;
    return new ClaudeRoutineApiError(message, { status: response.status, code: toErrorCode(body?.code), retryAfterSeconds: readRetryAfterSeconds(response) });
}

interface ClaudeRoutineRequest {
    method: 'GET' | 'PUT' | 'DELETE' | 'POST';
    path: string;
    body?: unknown;
}

/** One credentialed request; a network failure or timeout becomes a status-0 `ClaudeRoutineApiError`. */
async function request({ method, path, body }: ClaudeRoutineRequest): Promise<unknown> {
    const response = await fetch(`${API_SERVER}/account/claude-routine${path}`, {
        method,
        credentials: 'include',
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(CLAUDE_ROUTINE_TIMEOUT_MS),
    }).catch((err: unknown) => {
        // AbortSignal.timeout rejects with a TimeoutError; anything else is a network failure.
        const isTimeout = err instanceof Error && err.name === 'TimeoutError';
        throw new ClaudeRoutineApiError(err instanceof Error ? err.message : 'network error', { status: 0, code: isTimeout ? 'timeout' : undefined });
    });
    if (!response.ok) {
        throw await toApiError(response);
    }
    return response.json();
}

function parseConnectionView(body: unknown): ClaudeRoutineConnectionView {
    const row = asLooseObject<'connected' | 'claudeRoutineId' | 'tokenHint' | 'updatedTs'>(body);
    if (typeof row?.connected !== 'boolean') {
        throw new ClaudeRoutineApiError('unexpected Claude routine response', { status: 200 });
    }
    return {
        connected: row.connected,
        claudeRoutineId: typeof row.claudeRoutineId === 'string' ? row.claudeRoutineId : undefined,
        tokenHint: typeof row.tokenHint === 'string' ? row.tokenHint : undefined,
        updatedTs: typeof row.updatedTs === 'string' ? row.updatedTs : undefined,
    };
}

const OUTCOMES: readonly ClaudeAskOutcome[] = ['completed', 'needsInput'];

/** The identity + LWW fields the local store keys on; the row bypasses the op log, so it is checked here. */
export function isClaudeAskSnapshot(value: unknown): value is ServerClaudeAskSnapshot {
    const row = asLooseObject<'_id' | 'user' | 'itemId' | 'prompt' | 'sessionId' | 'sessionUrl' | 'createdTs' | 'updatedTs' | 'result'>(value);
    if (row === undefined) {
        return false;
    }
    const result = asLooseObject<'outcome'>(row.result);
    const isResultValid = row.result === undefined || OUTCOMES.some((outcome) => outcome === result?.outcome);
    return (
        typeof row._id === 'string' &&
        typeof row.user === 'string' &&
        typeof row.itemId === 'string' &&
        typeof row.prompt === 'string' &&
        typeof row.sessionId === 'string' &&
        typeof row.sessionUrl === 'string' &&
        typeof row.createdTs === 'string' &&
        typeof row.updatedTs === 'string' &&
        isResultValid
    );
}

export async function fetchClaudeRoutineConnection(): Promise<ClaudeRoutineConnectionView> {
    return parseConnectionView(await request({ method: 'GET', path: '' }));
}

export async function saveClaudeRoutineConnection(input: { claudeRoutineId: string; token: string }): Promise<ClaudeRoutineConnectionView> {
    return parseConnectionView(await request({ method: 'PUT', path: '', body: input }));
}

export async function disconnectClaudeRoutine(): Promise<ClaudeRoutineConnectionView> {
    return parseConnectionView(await request({ method: 'DELETE', path: '' }));
}

/** Starts the item owner's Claude routine for `itemId`; resolves with the recorded ask row. */
export async function askClaude(itemId: string, prompt: string): Promise<ServerClaudeAskSnapshot> {
    const { ask } = asLooseObject<'ask'>(await request({ method: 'POST', path: '/asks', body: { itemId, prompt } })) ?? {};
    if (!isClaudeAskSnapshot(ask)) {
        throw new ClaudeRoutineApiError('unexpected Ask Claude response', { status: 201 });
    }
    return ask;
}
