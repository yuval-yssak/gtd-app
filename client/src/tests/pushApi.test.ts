/** Tests for the small wrappers around /push/status and /devices/signout. The wrappers must
 *  pass `X-Device-Id` correctly and degrade gracefully on server errors so the Settings UI
 *  never crashes the page. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPushStatus, signOutDevice } from '../api/pushApi';

// VITE_API_SERVER from .env is inlined at build time — pushApi.ts targets `${API_SERVER}/...`.
// Resolve dynamically so tests pass whether the env var is set, empty, or different across CI envs.
const API_SERVER = import.meta.env.VITE_API_SERVER ?? '';

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
    // Replace global fetch only for the duration of each test — restored in afterEach.
    globalThis.fetch = fetchSpy as typeof fetch;
});

afterEach(() => {
    vi.restoreAllMocks();
});

function makeJsonResponse(body: unknown, status = 200): Response {
    // Response.ok is derived from the status code, so callers control "ok" by passing the status.
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('getPushStatus', () => {
    it('returns the parsed JSON when the server responds 200', async () => {
        fetchSpy.mockImplementationOnce((input, init) => {
            recordFetchCall(input as RequestInfo, init as RequestInit);
            return Promise.resolve(makeJsonResponse({ registered: true }));
        });

        const result = await getPushStatus('dev-1');
        expect(result).toEqual({ registered: true });
    });

    it('passes X-Device-Id header on the request', async () => {
        fetchSpy.mockImplementationOnce((input, init) => {
            recordFetchCall(input as RequestInfo, init as RequestInit);
            return Promise.resolve(makeJsonResponse({ registered: false }));
        });

        await getPushStatus('dev-abc');

        expect(fetchCalls).toHaveLength(1);
        // Header value comes through whether the test runner exposes Headers or a plain object —
        // toHaveProperty handles both shapes safely without an explicit cast.
        const headers = fetchCalls[0]?.init?.headers as Record<string, string> | undefined;
        expect(headers?.['X-Device-Id']).toBe('dev-abc');
    });

    it('targets POST /push/status with credentials included', async () => {
        fetchSpy.mockImplementationOnce((input, init) => {
            recordFetchCall(input as RequestInfo, init as RequestInit);
            return Promise.resolve(makeJsonResponse({ registered: true }));
        });

        await getPushStatus('dev-1');

        expect(fetchCalls[0]?.url).toBe(`${API_SERVER}/push/status`);
        expect(fetchCalls[0]?.init?.credentials).toBe('include');
    });

    it('falls back to { registered: false } when the server returns a non-OK status', async () => {
        // Models 401/500/404 — the Settings UI must not throw on a transient backend error.
        fetchSpy.mockImplementationOnce(() => Promise.resolve(new Response('boom', { status: 500, headers: { 'Content-Type': 'text/plain' } })));

        const result = await getPushStatus('dev-down');
        expect(result).toEqual({ registered: false });
    });
});

describe('signOutDevice', () => {
    it('POSTs to /devices/signout with deviceId in the body', async () => {
        fetchSpy.mockImplementationOnce((input, init) => {
            recordFetchCall(input as RequestInfo, init as RequestInit);
            return Promise.resolve(makeJsonResponse({ ok: true }));
        });

        await signOutDevice('dev-bye');

        expect(fetchCalls).toHaveLength(1);
        expect(fetchCalls[0]?.url).toBe(`${API_SERVER}/devices/signout`);
        expect(fetchCalls[0]?.init?.method).toBe('POST');
        expect(fetchCalls[0]?.init?.credentials).toBe('include');
        expect(fetchCalls[0]?.init?.body).toBe(JSON.stringify({ deviceId: 'dev-bye' }));
    });

    it('does not throw when the server returns an error — sign-out should remain best-effort', async () => {
        // The auth middleware fires the deviceUsers upsert as fire-and-forget; symmetric semantics
        // here mean a server hiccup must not block the local Better Auth signOut that follows.
        fetchSpy.mockImplementationOnce(() => Promise.resolve(makeJsonResponse({ error: 'boom' }, 500)));

        await expect(signOutDevice('dev-err')).resolves.toBeUndefined();
    });
});
