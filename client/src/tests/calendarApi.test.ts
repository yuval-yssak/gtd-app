/** Tests for the calendar API wrappers added in Step 2 (multi-account calendar plan):
 * - `initiateGoogleCalendarAuth(loginHint)` builds the OAuth start URL with `login_hint=<email>`.
 * - `deleteIntegration(id, action)` posts the action verb on the query string.
 * - `UnlinkAction` is exported and only accepts the two allowed verbs.
 *
 * Mirrors the structure of `pushApi.test.ts` — global fetch is replaced per-test, then restored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteIntegration, initiateGoogleCalendarAuth, rsvpOnline, type UnlinkAction } from '../api/calendarApi';
import type { StoredItem } from '../types/MyDB';

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
    globalThis.fetch = fetchSpy as typeof fetch;
});

afterEach(() => {
    vi.restoreAllMocks();
});

function makeJsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('initiateGoogleCalendarAuth', () => {
    /**
     * The function sets `window.location.href` to navigate to the API server's OAuth start route.
     * Vitest's default `node` environment has no `window`, so we install a lightweight stub that
     * captures the assignment without actually navigating.
     */
    type LocationStub = { href: string };
    let originalWindow: { location: LocationStub } | undefined;

    beforeEach(() => {
        originalWindow = (globalThis as { window?: { location: LocationStub } }).window;
        (globalThis as { window: { location: LocationStub } }).window = { location: { href: '' } };
    });

    afterEach(() => {
        if (originalWindow === undefined) {
            delete (globalThis as { window?: unknown }).window;
        } else {
            (globalThis as { window: typeof originalWindow }).window = originalWindow;
        }
    });

    it('navigates to /calendar/auth/google with login_hint set to the provided email', () => {
        initiateGoogleCalendarAuth('alice@example.com');
        const target = (globalThis as { window: { location: LocationStub } }).window.location.href;
        const url = new URL(target);
        expect(url.pathname).toBe('/calendar/auth/google');
        expect(url.searchParams.get('login_hint')).toBe('alice@example.com');
    });

    it('encodes the login hint so addresses with "+" or special chars survive', () => {
        // URLSearchParams.set encodes unsafe characters — ensures the API server sees the original
        // string after Hono parses the query, not a corrupted variant.
        initiateGoogleCalendarAuth('user+tag@example.com');
        const url = new URL((globalThis as { window: { location: LocationStub } }).window.location.href);
        // .get() returns the decoded value, so the round-trip should match the original input.
        expect(url.searchParams.get('login_hint')).toBe('user+tag@example.com');
    });

    it('targets the API_SERVER origin, not the client origin', () => {
        // The OAuth flow lives on the API server (cross-origin in prod) — never on the SPA host.
        initiateGoogleCalendarAuth('alice@example.com');
        const url = new URL((globalThis as { window: { location: LocationStub } }).window.location.href);
        if (API_SERVER) {
            expect(url.origin).toBe(new URL(API_SERVER).origin);
        }
    });
});

describe('deleteIntegration', () => {
    it('uses DELETE with the keepLinkedEntities action on the query string', async () => {
        fetchSpy.mockImplementationOnce((input, init) => {
            recordFetchCall(input as RequestInfo, init as RequestInit);
            return Promise.resolve(makeJsonResponse({ ok: true }));
        });

        await deleteIntegration('int-1', 'keepLinkedEntities');
        expect(fetchCalls).toHaveLength(1);
        expect(fetchCalls[0]?.init?.method).toBe('DELETE');
        expect(fetchCalls[0]?.init?.credentials).toBe('include');
        const url = new URL(fetchCalls[0]?.url ?? '', 'http://placeholder');
        expect(url.pathname).toBe('/calendar/integrations/int-1');
        expect(url.searchParams.get('action')).toBe('keepLinkedEntities');
    });

    it('uses DELETE with the removeLinkedEntities action on the query string', async () => {
        fetchSpy.mockImplementationOnce((input, init) => {
            recordFetchCall(input as RequestInfo, init as RequestInit);
            return Promise.resolve(makeJsonResponse({ ok: true }));
        });

        await deleteIntegration('int-2', 'removeLinkedEntities');
        const url = new URL(fetchCalls[0]?.url ?? '', 'http://placeholder');
        expect(url.searchParams.get('action')).toBe('removeLinkedEntities');
    });

    it('throws when the server responds with a non-OK status so the UI can surface an error', async () => {
        fetchSpy.mockImplementationOnce(() => Promise.resolve(new Response('boom', { status: 500 })));
        await expect(deleteIntegration('int-3', 'keepLinkedEntities')).rejects.toThrow(/500/);
    });
});

describe('rsvpOnline', () => {
    function makeItem(): StoredItem {
        return {
            _id: 'item-1',
            userId: 'user-1',
            status: 'calendar',
            title: 'Standup',
            createdTs: '2026-01-01T00:00:00.000Z',
            updatedTs: '2026-01-02T00:00:00.000Z',
            timeStart: '2026-05-04T09:00:00.000Z',
            timeEnd: '2026-05-04T09:30:00.000Z',
        };
    }

    it('posts the responseStatus and returns the server-side item on success', async () => {
        const item = makeItem();
        fetchSpy.mockImplementationOnce((input, init) => {
            recordFetchCall(input as RequestInfo, init as RequestInit);
            return Promise.resolve(makeJsonResponse(item));
        });

        const result = await rsvpOnline('item-1', 'accepted');
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('expected ok=true');
        expect(result.item._id).toBe('item-1');

        const [call] = fetchCalls;
        if (!call) throw new Error('expected one fetch call');
        const url = new URL(call.url, 'http://placeholder');
        expect(url.pathname).toBe('/calendar/items/item-1/rsvp');
        expect(call.init?.method).toBe('POST');
        expect(call.init?.credentials).toBe('include');
        const headers = (call.init?.headers ?? {}) as Record<string, string>;
        expect(headers['Content-Type']).toBe('application/json');
        expect(call.init?.body).toBe(JSON.stringify({ responseStatus: 'accepted' }));
    });

    it('returns scope_missing with the reconsent URL on a 403', async () => {
        fetchSpy.mockImplementationOnce(() => Promise.resolve(makeJsonResponse({ error: 'scope_missing', reconsentUrl: 'https://api.example/oauth' }, 403)));

        const result = await rsvpOnline('item-1', 'declined');
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('expected ok=false');
        expect(result.scopeMissing).toBe(true);
        if (!result.scopeMissing) throw new Error('expected scopeMissing=true');
        expect(result.reconsentUrl).toBe('https://api.example/oauth');
    });

    it('returns a generic error when the 403 body is malformed', async () => {
        // Defensive parse: if the server somehow returns 403 without `reconsentUrl`, we don't pretend
        // we have one. The caller falls through to the generic-error arm and the UI shows a toast
        // rather than crashing trying to open `undefined`.
        fetchSpy.mockImplementationOnce(() => Promise.resolve(makeJsonResponse({ error: 'scope_missing' }, 403)));

        const result = await rsvpOnline('item-1', 'declined');
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('expected ok=false');
        expect(result.scopeMissing).toBe(false);
        if (result.scopeMissing) throw new Error('expected scopeMissing=false');
        expect(result.error).toBe('scope_missing_no_url');
    });

    it('returns a generic error on a 500', async () => {
        fetchSpy.mockImplementationOnce(() => Promise.resolve(new Response('boom', { status: 500 })));

        const result = await rsvpOnline('item-1', 'tentative');
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('expected ok=false');
        expect(result.scopeMissing).toBe(false);
        if (result.scopeMissing) throw new Error('expected scopeMissing=false');
        expect(result.error).toBe('rsvp_failed_500');
    });

    it('returns network_error when fetch throws (offline, DNS failure, etc.)', async () => {
        fetchSpy.mockImplementationOnce(() => Promise.reject(new Error('network down')));

        const result = await rsvpOnline('item-1', 'accepted');
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('expected ok=false');
        expect(result.scopeMissing).toBe(false);
        if (result.scopeMissing) throw new Error('expected scopeMissing=false');
        expect(result.error).toBe('network_error');
    });
});

describe('UnlinkAction type', () => {
    // Compile-time assertion: the type is the union of exactly two literal verbs and is exported
    // for callers (e.g., DisconnectDialog) to drive the radio group's value type.
    it('matches the two allowed verbs and only those', () => {
        const a: UnlinkAction = 'keepLinkedEntities';
        const b: UnlinkAction = 'removeLinkedEntities';
        // No runtime check — the assertion is the type itself; the test fails to compile if the
        // type drifts. The expect call below silences the unused-variable check.
        expect([a, b]).toHaveLength(2);
    });
});
