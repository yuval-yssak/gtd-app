import { type ClaudeRoutineStartOutcome, classifyClaudeRoutineResponse } from './claudeRoutineResponse.js';

const FIRE_URL_BASE = 'https://api.anthropic.com/v1/claude_code/routines';

/**
 * Upstream budget. The client pivots the multi-account session cookie around this call and that
 * gate gives up after 10 s (`withAccountSession`), so the whole round trip must stay below it.
 */
export const CLAUDE_ROUTINE_START_TIMEOUT_MS = 7_000;

export interface ClaudeRoutineStart {
    /** Done's id for this ask — only the fake reads it; the real request carries it inside `text`. */
    askId: string;
    claudeRoutineId: string;
    token: string;
    text: string;
}

/**
 * Starts one run of the user's Claude routine (`POST /v1/claude_code/routines/{id}/fire`).
 * Every successful call is a new Claude Code session — the endpoint has no idempotency key, so
 * callers guard against double submits themselves. Never logs the token, the text or the body.
 */
export async function startClaudeRoutine(start: ClaudeRoutineStart): Promise<ClaudeRoutineStartOutcome> {
    if (process.env.CLAUDE_ROUTINE_FAKE === '1') {
        return fakeStart(start.askId);
    }
    try {
        const res = await fetch(`${FIRE_URL_BASE}/${encodeURIComponent(start.claudeRoutineId)}/fire`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${start.token}`,
                'anthropic-version': '2023-06-01',
                'anthropic-beta': 'experimental-cc-routine-2026-04-01',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ text: start.text }),
            signal: AbortSignal.timeout(CLAUDE_ROUTINE_START_TIMEOUT_MS),
        });
        const body: unknown = await res.json().catch(() => null);
        return classifyClaudeRoutineResponse(res.status, body, res.headers.get('retry-after'));
    } catch (err) {
        // Timeout or network failure. The session may still have been created upstream; the route
        // keeps the attempt marked in flight (`markClaudeAskStarting`) so a retry cannot open a second one.
        console.error('[claudeRoutine] start request failed', { name: err instanceof Error ? err.name : 'unknown' });
        return { ok: false, failure: { code: 'claude_routine_unreachable', status: 503 } };
    }
}

/**
 * Deterministic stand-in for e2e and local dev (`CLAUDE_ROUTINE_FAKE=1`); production refuses to
 * boot with the flag (config.ts). The session id is derived from the ask id, so a spec can
 * predict the link.
 */
function fakeStart(askId: string): ClaudeRoutineStartOutcome {
    const sessionId = `session_fake_${askId}`;
    return { ok: true, sessionId, sessionUrl: `https://claude.ai/code/${sessionId}` };
}
