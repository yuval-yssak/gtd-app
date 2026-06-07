/** Tests for the personal API tokens HTTP wrappers (`src/api/tokensApi.ts`).
 * Same harness as `calendarApi.test.ts` — global fetch replaced per-test, then restored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    type ApiTokenScope,
    createToken,
    DEFAULT_NEW_TOKEN_SCOPES,
    listTokens,
    MINTABLE_API_TOKEN_SCOPES,
    revokeToken,
    TokensApiError,
} from '../api/tokensApi';

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
        const [call] = fetchCalls;
        if (!call) throw new Error('expected one fetch call');
        expect(call.url).toContain('/account/tokens');
        expect(call.init?.credentials).toBe('include');
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
        const [call] = fetchCalls;
        if (!call) throw new Error('expected one fetch call');
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
        const [call] = fetchCalls;
        if (!call) throw new Error('expected one fetch call');
        expect(JSON.parse(call.init?.body as string)).toEqual({ label: 'capture-only', scopes: ['items.capture'] });
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
        const [call] = fetchCalls;
        if (!call) throw new Error('expected one fetch call');
        expect(JSON.parse(call.init?.body as string)).toEqual({ label: 'l' });
    });

    it('preserves the token_cap_reached code so callers can branch on it', async () => {
        fetchSpy.mockImplementationOnce(() => Promise.resolve(makeJsonResponse({ error: 'Token cap reached (20).', code: 'token_cap_reached' }, 429)));
        const err = await createToken('x').catch((e) => e);
        expect(err).toBeInstanceOf(TokensApiError);
        expect((err as TokensApiError).code).toBe('token_cap_reached');
        expect((err as TokensApiError).status).toBe(429);
    });
});

describe('MINTABLE_API_TOKEN_SCOPES', () => {
    // The write surface is exposed under `items.write` (the former `items.clarify` scope was
    // retired and its stored rows migrated to `items.write` server-side). Keep the negative pin —
    // a regression that re-introduces the retired literal to the mint UI must fail. Compared as a
    // plain string since `items.clarify` is no longer a member of the `ApiTokenScope` union.
    it('advertises items.write and never re-introduces the retired items.clarify scope', () => {
        expect(MINTABLE_API_TOKEN_SCOPES).toContain<ApiTokenScope>('items.write');
        expect(MINTABLE_API_TOKEN_SCOPES.length).toBeGreaterThan(0);
        expect(MINTABLE_API_TOKEN_SCOPES as string[]).not.toContain('items.clarify');
    });

    // The cross-account reassign gesture is a two-token proof: the source-side token carries
    // `reassign`, the destination-side carries `reassign.accept`. Both must be mintable from the
    // settings UI so a user can configure each side without dropping into a CLI / dev tools.
    it('exposes both reassign and reassign.accept so the UI can mint each side of the gesture', () => {
        expect(MINTABLE_API_TOKEN_SCOPES).toContain<ApiTokenScope>('reassign');
        expect(MINTABLE_API_TOKEN_SCOPES).toContain<ApiTokenScope>('reassign.accept');
    });

    // Regression pin from the post-review pass: `reassign` and `reassign.accept` are distinct entries,
    // not aliases. A future refactor that collapses one into the other (or treats them as a Set with
    // deduplicated semantics) would silently weaken the consent split that protects cross-account
    // moves. Asserting the literal pair as an array catches that.
    it('keeps reassign and reassign.accept as distinct entries — they are not aliases', () => {
        const reassignEntries = MINTABLE_API_TOKEN_SCOPES.filter((s) => s === 'reassign' || s === 'reassign.accept');
        expect(reassignEntries).toEqual(['reassign', 'reassign.accept']);
    });
});

describe('DEFAULT_NEW_TOKEN_SCOPES', () => {
    // The settings UI pre-checks DEFAULT_NEW_TOKEN_SCOPES on the new-token form. Cross-account
    // scopes (reassign + reassign.accept) must NOT be pre-checked: they're explicit opt-ins that
    // a user has to actively select. Pre-checking them by accident in a future refactor would
    // weaken the explicit-opt-in security property protected by the recipient-consent gate.
    it('does not pre-check reassign or reassign.accept on the create-token form — cross-account scopes must be explicit opt-in', () => {
        expect(DEFAULT_NEW_TOKEN_SCOPES).not.toContain<ApiTokenScope>('reassign');
        expect(DEFAULT_NEW_TOKEN_SCOPES).not.toContain<ApiTokenScope>('reassign.accept');
    });
});

describe('revokeToken', () => {
    it('DELETEs /account/tokens/:id with credentials', async () => {
        fetchSpy.mockImplementationOnce((input, init) => {
            recordFetchCall(input, init);
            return Promise.resolve(makeJsonResponse({ ok: true }));
        });
        await revokeToken('tok-42');
        const [call] = fetchCalls;
        if (!call) throw new Error('expected one fetch call');
        expect(call.url).toContain('/account/tokens/tok-42');
        expect(call.init?.method).toBe('DELETE');
        expect(call.init?.credentials).toBe('include');
    });

    it('throws TokensApiError on 404 with the server-supplied code', async () => {
        fetchSpy.mockImplementationOnce(() => Promise.resolve(makeJsonResponse({ error: 'token not found', code: 'not_found' }, 404)));
        const err = await revokeToken('missing').catch((e) => e);
        expect(err).toBeInstanceOf(TokensApiError);
        expect((err as TokensApiError).status).toBe(404);
        expect((err as TokensApiError).code).toBe('not_found');
    });
});
