/**
 * Tests for the SyncIssuesPanel HTTP wrappers (`src/api/syncApi.ts`).
 * Same harness as `tokensApi.test.ts` — global fetch replaced per-test, restored on cleanup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dismissSyncIssue, fetchSyncIssues, retrySyncIssue, type SyncIssue } from '../api/syncApi';

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

describe('fetchSyncIssues', () => {
    it('GETs /sync/issues with credentials and unwraps the issues array', async () => {
        const issue: SyncIssue = {
            _id: 'op-1',
            ts: '2026-05-23T00:00:00.000Z',
            opType: 'rsvp',
            entityType: 'item',
            entityId: 'item-1',
            entityTitle: 'Linked meeting',
            failureReason: 'scope_missing',
            retryable: true,
        };
        fetchSpy.mockImplementationOnce((input, init) => {
            recordFetchCall(input, init);
            return Promise.resolve(makeJsonResponse({ issues: [issue] }));
        });

        const result = await fetchSyncIssues();
        expect(result).toEqual([issue]);
        const [call] = fetchCalls;
        if (!call) throw new Error('expected one fetch call');
        expect(call.url).toContain('/sync/issues');
        // credentials:'include' is load-bearing — the Better Auth session cookie must ride along
        // cross-origin or the server returns 401 (silently empty list, hard to debug).
        expect(call.init?.credentials).toBe('include');
    });

    it('throws when the server returns non-2xx so the panel boundary can recover', async () => {
        fetchSpy.mockImplementationOnce(() => Promise.resolve(makeJsonResponse({ error: 'unauthorized' }, 401)));
        await expect(fetchSyncIssues()).rejects.toThrow(/sync\/issues 401/);
    });
});

describe('retrySyncIssue', () => {
    it('POSTs /sync/issues/:opId/retry and returns the discriminated result on success', async () => {
        fetchSpy.mockImplementationOnce((input, init) => {
            recordFetchCall(input, init);
            return Promise.resolve(makeJsonResponse({ ok: true }));
        });
        const result = await retrySyncIssue('op-1');
        expect(result).toEqual({ ok: true });
        const [call] = fetchCalls;
        if (!call) throw new Error('expected one fetch call');
        expect(call.url).toContain('/sync/issues/op-1/retry');
        expect(call.init?.method).toBe('POST');
        expect(call.init?.credentials).toBe('include');
    });

    it('returns ok:false when the retry endpoint itself errors so the panel keeps the row in place', async () => {
        fetchSpy.mockImplementationOnce(() => Promise.resolve(makeJsonResponse({ error: 'not retryable' }, 400)));
        const result = await retrySyncIssue('op-terminal');
        expect(result.ok).toBe(false);
    });
});

describe('dismissSyncIssue', () => {
    it('POSTs /sync/issues/:opId/dismiss and reports success', async () => {
        fetchSpy.mockImplementationOnce((input, init) => {
            recordFetchCall(input, init);
            return Promise.resolve(makeJsonResponse({ ok: true }));
        });
        const result = await dismissSyncIssue('op-2');
        expect(result.ok).toBe(true);
        const [call] = fetchCalls;
        if (!call) throw new Error('expected one fetch call');
        expect(call.url).toContain('/sync/issues/op-2/dismiss');
        expect(call.init?.method).toBe('POST');
        expect(call.init?.credentials).toBe('include');
    });

    it('reports ok:false when the server returns a non-2xx (e.g. 404 cross-tenant)', async () => {
        fetchSpy.mockImplementationOnce(() => Promise.resolve(makeJsonResponse({ error: 'not found' }, 404)));
        const result = await dismissSyncIssue('op-missing');
        expect(result.ok).toBe(false);
    });
});
