import { describe, expect, it } from 'vitest';
import { GtdApiError } from '../apiClient.js';
import { formatError } from '../tools/types.js';

/**
 * Pins the error-serialization contract: GtdApiError surfaces structured fields (status, code,
 * body) so the LLM can self-correct on matrix violations; generic Errors expose only `error`;
 * non-object bodies (HTML 502s) do NOT leak into the payload via `body`.
 */

interface ErrorPayload {
    error?: string;
    status?: number;
    code?: string;
    body?: unknown;
}

const decodePayload = (result: { content: { type: string; text: string }[] }): ErrorPayload => JSON.parse(result.content[0]?.text ?? '') as ErrorPayload;

describe('formatError', () => {
    it('serializes GtdApiError with status, code, and body for matrix-violation echoes', () => {
        const apiBody = { error: 'bad', code: 'status_field_violation', extra: { status: 'calendar', field: 'ignoreBefore' } };
        const result = formatError(new GtdApiError('bad', 400, apiBody));
        expect(result.isError).toBe(true);
        const parsed = decodePayload(result);
        expect(parsed.status).toBe(400);
        expect(parsed.code).toBe('status_field_violation');
        expect(parsed.body).toEqual(apiBody);
    });

    it('serializes a generic Error with only `error`', () => {
        const result = formatError(new Error('network down'));
        const parsed = decodePayload(result);
        expect(parsed.error).toBe('network down');
        expect(parsed).not.toHaveProperty('status');
        expect(parsed).not.toHaveProperty('body');
    });

    it('handles non-Error throw values', () => {
        const result = formatError('something');
        const parsed = decodePayload(result);
        expect(parsed.error).toBe('something');
    });

    it('does NOT include `body` when the API response was HTML / a string (502 with HTML)', () => {
        const err = new GtdApiError('HTTP 502', 502, '<html>Bad Gateway</html>');
        const result = formatError(err);
        const parsed = decodePayload(result);
        expect(parsed.status).toBe(502);
        expect(parsed).not.toHaveProperty('body');
    });
});
