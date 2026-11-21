import { isClaudeSessionUrl } from './claudeSessionUrl.js';

/** What a Claude routine start call came back with, in Done's terms. */
export type ClaudeRoutineStartFailure =
    | { code: 'claude_routine_token_rejected'; status: 422 }
    | { code: 'claude_routine_not_found'; status: 422 }
    | { code: 'claude_routine_unavailable'; status: 422 }
    | { code: 'claude_routine_rate_limited'; status: 429; retryAfterSeconds: number | null }
    | { code: 'claude_routine_unreachable'; status: 503 };

export type ClaudeRoutineStartOutcome = { ok: true; sessionId: string; sessionUrl: string } | { ok: false; failure: ClaudeRoutineStartFailure };

const UNREACHABLE: ClaudeRoutineStartFailure = { code: 'claude_routine_unreachable', status: 503 };

/**
 * Maps the `/fire` response to Done's outcome. 401/403/404/400 are problems the user fixes in
 * Settings or on claude.ai (a revoked token, a deleted or paused Claude routine), so they come
 * back as 422 rather than the operator-facing 503. Never 502/504 — Cloudflare would swap the body
 * for an HTML page.
 */
export function classifyClaudeRoutineResponse(status: number, body: unknown, retryAfter: string | null): ClaudeRoutineStartOutcome {
    if (status >= 200 && status < 300) {
        return parseStartedSession(body);
    }
    if (status === 401 || status === 403) {
        return { ok: false, failure: { code: 'claude_routine_token_rejected', status: 422 } };
    }
    if (status === 404) {
        return { ok: false, failure: { code: 'claude_routine_not_found', status: 422 } };
    }
    if (status === 400) {
        return { ok: false, failure: { code: 'claude_routine_unavailable', status: 422 } };
    }
    if (status === 429) {
        return { ok: false, failure: { code: 'claude_routine_rate_limited', status: 429, retryAfterSeconds: parseRetryAfter(retryAfter) } };
    }
    return { ok: false, failure: UNREACHABLE };
}

/** A 2xx without the session fields is a contract break upstream — treat it as unreachable. */
function parseStartedSession(body: unknown): ClaudeRoutineStartOutcome {
    if (typeof body !== 'object' || body === null) {
        return { ok: false, failure: UNREACHABLE };
    }
    const { claude_code_session_id: sessionId, claude_code_session_url: sessionUrl } = body as Record<string, unknown>;
    if (typeof sessionId !== 'string' || typeof sessionUrl !== 'string' || !sessionId || !isClaudeSessionUrl(sessionUrl)) {
        return { ok: false, failure: UNREACHABLE };
    }
    return { ok: true, sessionId, sessionUrl };
}

function parseRetryAfter(value: string | null): number | null {
    const seconds = Number(value);
    return value !== null && Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : null;
}
