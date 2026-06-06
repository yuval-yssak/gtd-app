/** Tests for the agent-error classifier (`src/lib/claude/agentError.ts`). */
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { classifyAgentError } from '../lib/claude/agentError.js';

function makeApiError(ErrorClass: typeof Anthropic.APIError, status: number, message: string, requestId = 'req_test'): Anthropic.APIError {
    const body = { type: 'error', error: { type: 'invalid_request_error', message } };
    // The SDK reads the request id off a Headers instance via headers.get('request-id').
    return new ErrorClass(status, body, message, new Headers({ 'request-id': requestId }));
}

describe('classifyAgentError', () => {
    it('maps the out-of-credits 400 to agent_unavailable (503) with a friendly message', () => {
        const err = makeApiError(Anthropic.BadRequestError, 400, 'Your credit balance is too low to access the Anthropic API.');
        const result = classifyAgentError(err);
        expect(result).toMatchObject({ status: 503, code: 'agent_unavailable' });
        expect(result.message).toMatch(/temporarily unavailable/i);
        // The raw body never reaches the user, but the operator log carries the request_id + detail.
        expect(result.message).not.toMatch(/credit balance/i);
        expect(result.logLine).toContain('req_test');
        expect(result.logLine).toMatch(/credit balance/i);
    });

    it('maps a missing API key to agent_unavailable (503)', () => {
        const result = classifyAgentError(new Error('ANTHROPIC_API_KEY is not configured'));
        expect(result).toMatchObject({ status: 503, code: 'agent_unavailable' });
        expect(result.logLine).toMatch(/not configured/i);
    });

    it('maps auth, rate-limit, overloaded, and 5xx errors to agent_unavailable', () => {
        const auth = classifyAgentError(makeApiError(Anthropic.AuthenticationError, 401, 'invalid x-api-key'));
        const rate = classifyAgentError(makeApiError(Anthropic.RateLimitError, 429, 'rate limited'));
        const overloaded = classifyAgentError(makeApiError(Anthropic.APIError, 529, 'overloaded'));
        const server = classifyAgentError(makeApiError(Anthropic.InternalServerError, 500, 'boom'));
        for (const result of [auth, rate, overloaded, server]) {
            expect(result.code).toBe('agent_unavailable');
            expect(result.status).toBe(503);
        }
    });

    it('maps a genuine bad request (not credits) to agent_error (502)', () => {
        const err = makeApiError(Anthropic.BadRequestError, 400, 'messages: at least one message is required');
        const result = classifyAgentError(err);
        expect(result).toMatchObject({ status: 502, code: 'agent_error' });
        expect(result.logLine).toContain('req_test');
    });

    it('maps a non-Anthropic error to agent_error (502) with the message in the log', () => {
        const result = classifyAgentError(new Error('something unexpected'));
        expect(result).toMatchObject({ status: 502, code: 'agent_error' });
        expect(result.logLine).toContain('something unexpected');
    });

    it('maps an APIConnectionError (status undefined) to agent_error (502)', () => {
        // A connection error is an APIError but has no status, so it falls through to the generic
        // path. Pinning this guards a future "treat connection errors as unavailable" change.
        const result = classifyAgentError(new Anthropic.APIConnectionError({ message: 'socket hang up' }));
        expect(result).toMatchObject({ status: 502, code: 'agent_error' });
    });
});
