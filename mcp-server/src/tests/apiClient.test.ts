import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient, GtdApiError } from '../apiClient.js';

/**
 * Verifies the fetch wrapper: auth header (with multi-account selection), JSON body handling,
 * query-param encoding, the X-Reassign-Recipient-Token header, and error mapping that preserves
 * the API's `extra: { status, field }` shape — the load-bearing detail that lets the LLM
 * self-correct on status×field violations.
 */

const config = {
    apiBase: 'http://localhost:4000',
    environment: 'local' as const,
    tokens: new Map([
        ['default', 'gtd_default_token'],
        ['work', 'gtd_work_token'],
    ]),
};

describe('apiClient', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('attaches Authorization for the default account when no `account` opt is supplied', async () => {
        const fetchMock = vi.mocked(globalThis.fetch);
        fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
        const api = createApiClient(config);
        await api.request('GET', '/v1/items');
        expect(fetchMock).toHaveBeenCalledOnce();
        const [, init] = fetchMock.mock.calls[0] ?? [];
        expect((init?.headers as { Authorization?: string }).Authorization).toBe('Bearer gtd_default_token');
    });

    it('selects the requested non-default account when `opts.account` is provided', async () => {
        const fetchMock = vi.mocked(globalThis.fetch);
        fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
        const api = createApiClient(config);
        await api.request('GET', '/v1/items', undefined, undefined, { account: 'work' });
        const [, init] = fetchMock.mock.calls[0] ?? [];
        expect((init?.headers as { Authorization?: string }).Authorization).toBe('Bearer gtd_work_token');
    });

    it('lowercases the account label so config keys and call-site labels can mix case', async () => {
        const fetchMock = vi.mocked(globalThis.fetch);
        fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
        const api = createApiClient(config);
        await api.request('GET', '/v1/items', undefined, undefined, { account: 'WORK' });
        const [, init] = fetchMock.mock.calls[0] ?? [];
        expect((init?.headers as { Authorization?: string }).Authorization).toBe('Bearer gtd_work_token');
    });

    it('throws GtdApiError(400, unknown_account) when the account label has no configured token', async () => {
        const api = createApiClient(config);
        await expect(api.request('GET', '/v1/items', undefined, undefined, { account: 'nope' })).rejects.toMatchObject({
            name: 'GtdApiError',
            status: 400,
            code: 'unknown_account',
        });
    });

    it('attaches X-Reassign-Recipient-Token from the configured recipient account', async () => {
        const fetchMock = vi.mocked(globalThis.fetch);
        fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
        const api = createApiClient(config);
        await api.request('POST', '/v1/reassign', { entityType: 'item' }, undefined, { account: 'default', recipientAccount: 'work' });
        const [, init] = fetchMock.mock.calls[0] ?? [];
        const headers = init?.headers as { Authorization?: string; 'X-Reassign-Recipient-Token'?: string };
        expect(headers.Authorization).toBe('Bearer gtd_default_token');
        expect(headers['X-Reassign-Recipient-Token']).toBe('gtd_work_token');
    });

    it('serializes body as JSON for POST/PATCH and sets Content-Type', async () => {
        const fetchMock = vi.mocked(globalThis.fetch);
        fetchMock.mockResolvedValueOnce(new Response('{"_id":"abc"}', { status: 201 }));
        const api = createApiClient(config);
        await api.request('POST', '/v1/items', { title: 'hi' });
        const [, init] = fetchMock.mock.calls[0] ?? [];
        expect(init?.method).toBe('POST');
        expect(init?.body).toBe(JSON.stringify({ title: 'hi' }));
        expect((init?.headers as { 'Content-Type'?: string })['Content-Type']).toBe('application/json');
    });

    it('encodes query params and skips undefined / empty', async () => {
        const fetchMock = vi.mocked(globalThis.fetch);
        fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
        const api = createApiClient(config);
        await api.request('GET', '/v1/items', undefined, { q: 'milk', limit: 10, since: undefined, cursor: '' });
        const [url] = fetchMock.mock.calls[0] ?? [];
        const parsed = new URL(String(url));
        expect(parsed.searchParams.get('q')).toBe('milk');
        expect(parsed.searchParams.get('limit')).toBe('10');
        expect(parsed.searchParams.has('since')).toBe(false);
        expect(parsed.searchParams.has('cursor')).toBe(false);
    });

    it('throws GtdApiError preserving the API body on non-2xx, including extra:{status,field}', async () => {
        const fetchMock = vi.mocked(globalThis.fetch);
        const errorBody = {
            error: 'field "ignoreBefore" is not allowed when status is "calendar"',
            code: 'status_field_violation',
            extra: { status: 'calendar', field: 'ignoreBefore' },
        };
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(errorBody), { status: 400, headers: { 'content-type': 'application/json' } }));
        const api = createApiClient(config);
        await expect(api.request('PATCH', '/v1/items/abc', { status: 'calendar', ignoreBefore: '2026-05-09' })).rejects.toMatchObject({
            name: 'GtdApiError',
            status: 400,
            code: 'status_field_violation',
            body: errorBody,
        });
    });

    it('strips trailing slash from apiBase', async () => {
        const fetchMock = vi.mocked(globalThis.fetch);
        fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
        const api = createApiClient({ apiBase: 'http://localhost:4000/', environment: 'local', tokens: new Map([['default', 't']]) });
        await api.request('GET', '/v1/items');
        const [url] = fetchMock.mock.calls[0] ?? [];
        expect(String(url)).toBe('http://localhost:4000/v1/items');
    });

    it('listAccounts() returns configured labels in env-var insertion order', () => {
        const api = createApiClient(config);
        expect(api.listAccounts()).toEqual(['default', 'work']);
    });

    it('environment() and apiBase() echo the loadConfig-derived values', () => {
        const api = createApiClient(config);
        expect(api.environment()).toBe('local');
        expect(api.apiBase()).toBe('http://localhost:4000');
        const prodApi = createApiClient({
            apiBase: 'https://api.getting-things-done.app',
            environment: 'production',
            tokens: new Map([['default', 't']]),
        });
        expect(prodApi.environment()).toBe('production');
        expect(prodApi.apiBase()).toBe('https://api.getting-things-done.app');
    });

    it('GtdApiError exposes status, code, and body', () => {
        const err = new GtdApiError('boom', 500, { error: 'boom', code: 'internal' });
        expect(err.status).toBe(500);
        expect(err.code).toBe('internal');
        expect(err.body).toEqual({ error: 'boom', code: 'internal' });
    });

    it('URL-encodes query params with spaces and special characters', async () => {
        const fetchMock = vi.mocked(globalThis.fetch);
        fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
        const api = createApiClient(config);
        await api.request('GET', '/v1/items', undefined, { q: 'milk & eggs' });
        const [url] = fetchMock.mock.calls[0] ?? [];
        const parsed = new URL(String(url));
        expect(parsed.searchParams.get('q')).toBe('milk & eggs');
        expect(String(url)).toContain('q=milk+%26+eggs');
    });

    it('returns undefined for empty response bodies (204-like)', async () => {
        const fetchMock = vi.mocked(globalThis.fetch);
        // Response constructor rejects a non-null body with 204; use null to match real semantics.
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
        const api = createApiClient(config);
        const result = await api.request<unknown>('DELETE', '/v1/items/abc');
        expect(result).toBeUndefined();
    });

    it('keeps the raw HTML body in GtdApiError but does not crash on JSON parse', async () => {
        const fetchMock = vi.mocked(globalThis.fetch);
        fetchMock.mockResolvedValueOnce(new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }));
        const api = createApiClient(config);
        await expect(api.request('GET', '/v1/items')).rejects.toMatchObject({
            name: 'GtdApiError',
            status: 502,
            body: '<html>Bad Gateway</html>',
        });
    });
});
