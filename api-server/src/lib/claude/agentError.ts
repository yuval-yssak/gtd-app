import Anthropic from '@anthropic-ai/sdk';

/**
 * Classifies a thrown agent-loop error into a response code + status + user-facing message, and a
 * log line for the operator. The key distinction:
 *
 *   - `agent_unavailable` (503) — the failure is on OUR side of the Anthropic relationship and the
 *     END USER cannot act on it: our API account is out of credits, the key is missing/invalid, the
 *     API is overloaded (529) or rate-limited (429), or any 5xx. The user sees a "temporarily
 *     unavailable, try later" message — distinct from THEIR own per-day spend cap (402).
 *   - `agent_error` (502) — a genuinely unexpected failure (malformed request we built, a bug). The
 *     user sees a generic "couldn't finish, try again".
 *
 * Either way the operator gets a `console.error` with the status + Anthropic request_id so a silent
 * "agent_error" in the client is no longer a dead end when debugging.
 */

export interface ClassifiedAgentError {
    status: 502 | 503;
    code: 'agent_error' | 'agent_unavailable';
    /** User-facing message returned in the response body. */
    message: string;
    /** Operator-facing one-liner for the server log (includes the request_id when present). */
    logLine: string;
}

const UNAVAILABLE_MESSAGE = 'Claude is temporarily unavailable. Please try again in a little while.';
const GENERIC_MESSAGE = 'The assistant could not complete the request.';

type ApiError = InstanceType<typeof Anthropic.APIError>;

/** True when an Anthropic 400 is actually the "out of credits" billing error (not a real bad request). */
function isCreditBalanceError(err: ApiError): boolean {
    return err.status === 400 && /credit balance is too low/i.test(err.message);
}

/** True when the failure is on our side and the user can only wait/retry, never fix it themselves. */
function isOperatorUnavailable(err: ApiError): boolean {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.RateLimitError) {
        return true;
    }
    // 529 overloaded, any 5xx, or the out-of-credits 400.
    return err.status === 529 || (typeof err.status === 'number' && err.status >= 500) || isCreditBalanceError(err);
}

export function classifyAgentError(err: unknown): ClassifiedAgentError {
    // The missing-key guard throws a plain Error before the SDK is even constructed.
    if (err instanceof Error && err.message === 'ANTHROPIC_API_KEY is not configured') {
        return { status: 503, code: 'agent_unavailable', message: UNAVAILABLE_MESSAGE, logLine: 'ANTHROPIC_API_KEY is not configured' };
    }
    if (err instanceof Anthropic.APIError) {
        const requestId = err.requestID ?? 'unknown';
        if (isOperatorUnavailable(err)) {
            return {
                status: 503,
                code: 'agent_unavailable',
                message: UNAVAILABLE_MESSAGE,
                logLine: `Anthropic unavailable (status=${err.status ?? 'n/a'}, request_id=${requestId}): ${err.message}`,
            };
        }
        return {
            status: 502,
            code: 'agent_error',
            message: GENERIC_MESSAGE,
            logLine: `Anthropic error (status=${err.status ?? 'n/a'}, request_id=${requestId}): ${err.message}`,
        };
    }
    const detail = err instanceof Error ? err.message : 'unknown error';
    return { status: 502, code: 'agent_error', message: GENERIC_MESSAGE, logLine: `Agent loop failed: ${detail}` };
}
