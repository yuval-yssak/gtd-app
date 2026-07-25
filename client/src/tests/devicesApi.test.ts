/** Tests for the connected-devices HTTP wrappers (`src/api/devicesApi.ts`).
 * Same harness as `tokensApi.test.ts` — global fetch replaced per-test, then restored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesApiError, listConnectedDevices, removeDevice, renameDevice } from '../api/devicesApi';

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

const SAMPLE_DEVICE = {
    deviceId: 'dev-1',
    autoLabel: 'Chrome on macOS',
    lastSeenTs: '2026-07-01T00:00:00.000Z',
    lastSyncedTs: '2026-07-01T00:00:00.000Z',
    opsBehind: 0,
    holdsPurgeFloor: true,
};

describe('listConnectedDevices', () => {
    it('GETs /devices with credentials and returns the payload', async () => {
        fetchSpy.mockImplementationOnce((input, init) => {
            recordFetchCall(input, init);
            return Promise.resolve(makeJsonResponse({ devices: [SAMPLE_DEVICE], totalOps: 12 }));
        });
        const result = await listConnectedDevices();
        expect(result).toEqual({ devices: [SAMPLE_DEVICE], totalOps: 12 });
        expect(fetchCalls).toHaveLength(1);
        const [call] = fetchCalls;
        if (!call) throw new Error('expected one fetch call');
        expect(call.url).toMatch(/\/devices$/);
        expect(call.init?.credentials).toBe('include');
        expect(call.init?.method).toBeUndefined(); // default GET
    });

    it('throws DevicesApiError carrying the status and server message on failure', async () => {
        fetchSpy.mockResolvedValueOnce(makeJsonResponse({ error: 'boom' }, 500));
        const error = await listConnectedDevices().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DevicesApiError);
        expect((error as DevicesApiError).status).toBe(500);
        expect((error as DevicesApiError).message).toBe('boom');
    });
});

describe('renameDevice', () => {
    it('PATCHes /devices/:deviceId with the JSON name body', async () => {
        fetchSpy.mockImplementationOnce((input, init) => {
            recordFetchCall(input, init);
            return Promise.resolve(makeJsonResponse({ ok: true }));
        });
        await renameDevice('dev-1', 'Work laptop');
        const [call] = fetchCalls;
        if (!call) throw new Error('expected one fetch call');
        expect(call.url).toMatch(/\/devices\/dev-1$/);
        expect(call.init?.method).toBe('PATCH');
        expect(JSON.parse(call.init?.body as string)).toEqual({ name: 'Work laptop' });
    });

    it('URL-encodes the deviceId path segment', async () => {
        fetchSpy.mockImplementationOnce((input, init) => {
            recordFetchCall(input, init);
            return Promise.resolve(makeJsonResponse({ ok: true }));
        });
        await renameDevice('dev/with slash', 'X');
        const [call] = fetchCalls;
        if (!call) throw new Error('expected one fetch call');
        expect(call.url).toContain('/devices/dev%2Fwith%20slash');
    });
});

describe('removeDevice', () => {
    it('DELETEs /devices/:deviceId and returns the purged-ops count', async () => {
        fetchSpy.mockImplementationOnce((input, init) => {
            recordFetchCall(input, init);
            return Promise.resolve(makeJsonResponse({ ok: true, purgedOps: 42 }));
        });
        const result = await removeDevice('dev-1');
        expect(result.purgedOps).toBe(42);
        const [call] = fetchCalls;
        if (!call) throw new Error('expected one fetch call');
        expect(call.url).toMatch(/\/devices\/dev-1$/);
        expect(call.init?.method).toBe('DELETE');
    });

    it('surfaces a 404 (already removed) as DevicesApiError with status 404', async () => {
        fetchSpy.mockResolvedValueOnce(makeJsonResponse({ error: 'device not found' }, 404));
        const error = await removeDevice('dev-gone').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DevicesApiError);
        expect((error as DevicesApiError).status).toBe(404);
    });
});
