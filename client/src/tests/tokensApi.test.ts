/** Tests for the personal API tokens HTTP wrappers (`src/api/tokensApi.ts`).
 * Same harness as `calendarApi.test.ts` — global fetch replaced per-test, then restored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createToken, listTokens, revokeToken, TokensApiError } from '../api/tokensApi';

interface FetchCall {
    url: string;
    init: RequestInit | undefined;
}

let fetchSpy: ReturnType<typeof vi.fn>;
const fetchCalls: FetchCall[] = [];

function recordFetchCall(input: RequestInfo | URL, init?: RequestInit) {
    fetchCalls.push({ url: typeof input === 'string' ? input : input.toString(), init });
}

beforeEach(() => {
    fetchCalls.length = 0;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;
});

afterEach(() => {
    vi.restoreAllMocks();
});

function makeJsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('listTokens', () => {
    it('GETs /account/tokens with credentials and returns the unwrapped tokens array', async () => {
        fetchSpy.mockImplementationOnce((input, init) => {
            recordFetchCall(input, init);
            return Promise.resolve(makeJsonResponse({ tokens: [{ id: 'a', label: 'one', createdTs: '2026-01-01T00:00:00.000Z' }] }));
        });
        const result = await listTokens();
        expect(result).toEqual([{ id: 'a', label: 'one', createdTs: '2026-01-01T00:00:00.000Z' }]);
        expect(fetchCalls).toHaveLength(1);
        expect(fetchCalls[0]!.url).toContain('/account/tokens');
        expect(fetchCalls[0]!.init?.credentials).toBe('include');
    });

    it('throws TokensApiError carrying the server status, message, and code on non-2xx', async () => {
        // Configure two responses since both `expect(...).rejects.*` invocations make their own listTokens() call.
        fetchSpy
            .mockImplementationOnce(() => Promise.resolve(makeJsonResponse({ error: 'No session', code: 'unauthorized' }, 401)))
            .mockImplementationOnce(() => Promise.resolve(makeJsonResponse({ error: 'No session', code: 'unauthorized' }, 401)));
        await expect(listTokens()).rejects.toMatchObject({ status: 401, message: 'No session', code: 'unauthorized' });
        await expect(listTokens()).rejects.toBeInstanceOf(TokensApiError);
    });

    it('throws TokensApiError with code=undefined when the error body is not JSON', async () => {
        fetchSpy.mockImplementationOnce(() => Promise.resolve(new Response('Internal Server Error', { status: 500 })));
        const err = await listTokens().catch((e) => e);
        expect(err).toBeInstanceOf(TokensApiError);
        expect((err as TokensApiError).status).toBe(500);
        expect((err as TokensApiError).code).toBeUndefined();
    });
});

describe('createToken', () => {
    it('POSTs JSON with the label and returns the parsed response (including plaintext)', async () => {
        fetchSpy.mockImplementationOnce((input, init) => {
            recordFetchCall(input, init);
            return Promise.resolve(makeJsonResponse({ id: 'tok-1', label: 'iOS Shortcut', createdTs: '2026-01-01T00:00:00.000Z', plaintext: 'gtd_secret' }));
        });
        const result = await createToken('iOS Shortcut');
        expect(result.plaintext).toBe('gtd_secret');
        expect(result.label).toBe('iOS Shortcut');
        const call = fetchCalls[0]!;
        expect(call.init?.method).toBe('POST');
        expect(call.init?.credentials).toBe('include');
        expect((call.init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
        expect(JSON.parse(call.init?.body as string)).toEqual({ label: 'iOS Shortcut' });
    });

    it('passes scopes through when provided so callers can mint capability-restricted tokens', async () => {
        fetchSpy.mockImplementationOnce((input, init) => {
            recordFetchCall(input, init);
            return Promise.resolve(
                makeJsonResponse({
                    id: 'tok-1',
                    label: 'capture-only',
                    createdTs: '2026-01-01T00:00:00.000Z',
                    scopes: ['items.capture'],
                    plaintext: 'gtd_secret',
                }),
            );
        });
        const result = await createToken('capture-only', ['items.capture']);
        expect(result.scopes).toEqual(['items.capture']);
        expect(JSON.parse(fetchCalls[0]!.init?.body as string)).toEqual({ label: 'capture-only', scopes: ['items.capture'] });
    });

    it('omits scopes from the request body when caller does not specify, so server uses its default', async () => {
        fetchSpy.mockImplementationOnce((input, init) => {
            recordFetchCall(input, init);
            return Promise.resolve(
                makeJsonResponse({
                    id: 'tok-1',
                    label: 'l',
                    createdTs: '2026-01-01T00:00:00.000Z',
                    scopes: ['items.capture', 'items.read'],
                    plaintext: 'gtd_x',
                }),
            );
        });
        await createToken('l');
        expect(JSON.parse(fetchCalls[0]!.init?.body as string)).toEqual({ label: 'l' });
    });

    it('preserves the token_cap_reached code so callers can branch on it', async () => {
        fetchSpy.mockImplementationOnce(() => Promise.resolve(makeJsonResponse({ error: 'Token cap reached (20).', code: 'token_cap_reached' }, 429)));
        const err = await createToken('x').catch((e) => e);
        expect(err).toBeInstanceOf(TokensApiError);
        expect((err as TokensApiError).code).toBe('token_cap_reached');
        expect((err as TokensApiError).status).toBe(429);
    });
});

describe('revokeToken', () => {
    it('DELETEs /account/tokens/:id with credentials', async () => {
        fetchSpy.mockImplementationOnce((input, init) => {
            recordFetchCall(input, init);
            return Promise.resolve(makeJsonResponse({ ok: true }));
        });
        await revokeToken('tok-42');
        expect(fetchCalls[0]!.url).toContain('/account/tokens/tok-42');
        expect(fetchCalls[0]!.init?.method).toBe('DELETE');
        expect(fetchCalls[0]!.init?.credentials).toBe('include');
    });

    it('throws TokensApiError on 404 with the server-supplied code', async () => {
        fetchSpy.mockImplementationOnce(() => Promise.resolve(makeJsonResponse({ error: 'token not found', code: 'not_found' }, 404)));
        const err = await revokeToken('missing').catch((e) => e);
        expect(err).toBeInstanceOf(TokensApiError);
        expect((err as TokensApiError).status).toBe(404);
        expect((err as TokensApiError).code).toBe('not_found');
    });
});
