import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    BOOTSTRAP_TIMEOUT_MS,
    BootstrapRequiredError,
    fetchBootstrap,
    fetchDeviceStatus,
    fetchSyncOps,
    fetchVapidConfig,
    PULL_TIMEOUT_MS,
    PUSH_TIMEOUT_MS,
    pushSyncOps,
    registerPushEndpoint,
    STATUS_PROBE_TIMEOUT_MS,
    SyncAuthError,
} from '../api/syncClient';

function mockFetchResponse(status: number, body: unknown = {}): void {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }));
}

/** A first-page pull request from `ts`, acknowledging the same cursor. */
function pullRequest(ts: string) {
    return { cursor: { ts, id: '' }, acked: { ts, id: '' }, deviceId: 'device-1', limit: 100 };
}

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('syncClient — 401 handling', () => {
    it('pushSyncOps throws SyncAuthError on 401', async () => {
        mockFetchResponse(401);
        await expect(pushSyncOps('device-1', [])).rejects.toBeInstanceOf(SyncAuthError);
    });

    it('pushSyncOps throws a plain Error on other non-ok statuses', async () => {
        mockFetchResponse(500);
        const error = await pushSyncOps('device-1', []).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(SyncAuthError);
    });

    it('fetchBootstrap throws SyncAuthError on 401', async () => {
        mockFetchResponse(401);
        await expect(fetchBootstrap('device-1')).rejects.toBeInstanceOf(SyncAuthError);
    });

    it('fetchSyncOps throws SyncAuthError on 401', async () => {
        mockFetchResponse(401);
        await expect(fetchSyncOps(pullRequest('2025-01-01T00:00:00.000Z'))).rejects.toBeInstanceOf(SyncAuthError);
    });
});

describe('syncClient — bootstrap deviceLabel', () => {
    it('fetchBootstrap sends deviceLabel as a query param when provided', async () => {
        const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
        vi.stubGlobal('fetch', fetchSpy);
        await fetchBootstrap('device-1', 'Chrome on macOS');
        const [url] = fetchSpy.mock.calls[0] as [string];
        expect(url).toContain('deviceId=device-1');
        // URLSearchParams form-encodes spaces as '+'
        expect(url).toContain('deviceLabel=Chrome+on+macOS');
    });

    it('fetchBootstrap omits deviceLabel from the URL when not provided', async () => {
        const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
        vi.stubGlobal('fetch', fetchSpy);
        await fetchBootstrap('device-1');
        const [url] = fetchSpy.mock.calls[0] as [string];
        expect(url).not.toContain('deviceLabel');
    });
});

describe('syncClient — app version report', () => {
    function stubOkFetch() {
        const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
        vi.stubGlobal('fetch', fetchSpy);
        return fetchSpy;
    }

    function requestedUrl(fetchSpy: ReturnType<typeof vi.fn>): URL {
        const [call] = fetchSpy.mock.calls;
        if (!call) throw new Error('expected one fetch call');
        return new URL(String(call[0]));
    }

    it('fetchBootstrap reports the running build’s commit hash', async () => {
        const fetchSpy = stubOkFetch();
        await fetchBootstrap('device-1');
        expect(requestedUrl(fetchSpy).searchParams.get('appVersion')).toBe(__COMMIT_HASH__);
    });

    it('fetchSyncOps reports the running build’s commit hash alongside the timezone', async () => {
        const fetchSpy = stubOkFetch();
        await fetchSyncOps(pullRequest('2025-01-01T00:00:00.000Z'));
        const { searchParams } = requestedUrl(fetchSpy);
        expect(searchParams.get('appVersion')).toBe(__COMMIT_HASH__);
        expect(searchParams.get('timezone')).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    });
});

describe('syncClient — reaped-device signals', () => {
    it('fetchSyncOps throws BootstrapRequiredError on 409 (device row missing server-side)', async () => {
        mockFetchResponse(409, { bootstrapRequired: true });
        await expect(fetchSyncOps(pullRequest('2025-01-01T00:00:00.000Z'))).rejects.toBeInstanceOf(BootstrapRequiredError);
    });

    it('fetchDeviceStatus returns the parsed registration flag', async () => {
        mockFetchResponse(200, { registered: false });
        await expect(fetchDeviceStatus('device-1')).resolves.toEqual({ registered: false });
    });

    it('fetchDeviceStatus throws SyncAuthError on 401 and a plain Error otherwise', async () => {
        mockFetchResponse(401);
        await expect(fetchDeviceStatus('device-1')).rejects.toBeInstanceOf(SyncAuthError);
        mockFetchResponse(500);
        const error = await fetchDeviceStatus('device-1').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(SyncAuthError);
    });
});

// A push that never completes used to pin the cross-context flush lock until Cloudflare's 100s origin
// timeout, stranding every other context's queued ops meanwhile. The request now carries a deadline.
describe('syncClient — push deadline', () => {
    it('pushSyncOps sends an abort signal so a hung request cannot hold the flush lock indefinitely', async () => {
        const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
        vi.stubGlobal('fetch', fetchSpy);
        await pushSyncOps('device-1', []);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [firstCall] = fetchSpy.mock.calls;
        if (!firstCall) throw new Error('expected one fetch call');
        const [, init] = firstCall as [string, RequestInit];
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(init.signal?.aborted).toBe(false);
    });

    it('pushSyncOps surfaces a timeout abort as a plain Error naming the deadline (not SyncAuthError)', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('signal timed out', 'TimeoutError')));
        await expect(pushSyncOps('device-1', [])).rejects.toThrow(`${PUSH_TIMEOUT_MS}ms`);
        await expect(pushSyncOps('device-1', [])).rejects.not.toBeInstanceOf(SyncAuthError);
    });

    it('pushSyncOps rethrows non-timeout network failures unchanged', async () => {
        const networkFailure = new TypeError('Failed to fetch');
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(networkFailure));
        await expect(pushSyncOps('device-1', [])).rejects.toBe(networkFailure);
    });
});

/** A network that never answers ("lie-fi"), but honours an abort the way the browser's fetch does. */
function stubHangingFetch() {
    vi.stubGlobal(
        'fetch',
        vi.fn(
            (_url: string, init?: RequestInit) =>
                new Promise((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
                }),
        ),
    );
}

// A pull that never answers held the sync orchestrator's in-flight guard and the session gate until
// the browser gave up — minutes — so even after the network recovered nothing synced and the item
// badges stayed "Not verified". Each idempotent read now gives up on its own deadline.
describe('syncClient — read deadlines', () => {
    it.each([
        ['GET /sync/pull', PULL_TIMEOUT_MS, () => fetchSyncOps(pullRequest('1970-01-01T00:00:00.000Z'))],
        ['GET /sync/bootstrap', BOOTSTRAP_TIMEOUT_MS, () => fetchBootstrap('device-1')],
        ['GET /sync/device-status', STATUS_PROBE_TIMEOUT_MS, () => fetchDeviceStatus('device-1')],
    ])('%s rejects, naming its deadline, when the server never answers', async (route, deadlineMs, request) => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        stubHangingFetch();

        const settled = request().then(
            () => 'resolved',
            (err: unknown) => err,
        );
        await vi.advanceTimersByTimeAsync(deadlineMs);

        const outcome = await settled;
        expect(outcome).toBeInstanceOf(Error);
        expect(String(outcome)).toContain(`${route} timed out after ${deadlineMs}ms`);
    });

    // The pull is unpaginated: a device back from weeks offline downloads a large body over a slow
    // link. The deadline guards the hang (no headers ever), never a long but progressing download.
    it('GET /sync/pull still succeeds when headers arrive in time but the body takes longer than the deadline', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const payload = { ops: [], serverTs: '2026-11-16T10:00:00.000Z', serverId: '' };
        vi.stubGlobal(
            'fetch',
            vi.fn(async (_url: string, init?: RequestInit) => ({
                ok: true,
                status: 200,
                // Like the browser's body stream, the read dies if the request's signal aborts mid-download.
                json: () =>
                    new Promise((resolve, reject) => {
                        setTimeout(() => resolve(payload), PULL_TIMEOUT_MS * 2);
                        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
                    }),
            })),
        );

        const pulled = fetchSyncOps(pullRequest('1970-01-01T00:00:00.000Z'));
        await vi.advanceTimersByTimeAsync(PULL_TIMEOUT_MS * 2);

        await expect(pulled).resolves.toEqual(payload);
    });
});

describe('syncClient — pull paging', () => {
    it('fetchSyncOps sends the page size as `limit`', async () => {
        const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ ops: [], serverTs: '', serverId: '' }) });
        vi.stubGlobal('fetch', fetchSpy);

        await fetchSyncOps({ ...pullRequest('2025-01-01T00:00:00.000Z'), limit: 37 });

        const [firstCall] = fetchSpy.mock.calls;
        if (!firstCall) throw new Error('expected one fetch call');
        expect(new URL(String(firstCall[0])).searchParams.get('limit')).toBe('37');
    });
});

// Push registration is a connection-supervisor step: a hang there used to stall every later repair,
// and a 5xx answer used to count as "registered", so push stayed off for the page session.
describe('syncClient — push registration requests', () => {
    const subscription = { endpoint: 'https://push.example/1', keys: { p256dh: 'k', auth: 'a' } };

    it.each([
        ['GET /sync/config', () => fetchVapidConfig()],
        ['POST /push/subscribe', () => registerPushEndpoint('device-1', subscription)],
    ])('%s gives up once its deadline passes', async (route, request) => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        stubHangingFetch();

        const settled = request().then(
            () => 'resolved',
            (err: unknown) => err,
        );
        await vi.advanceTimersByTimeAsync(STATUS_PROBE_TIMEOUT_MS);

        expect(String(await settled)).toContain(`${route} timed out after ${STATUS_PROBE_TIMEOUT_MS}ms`);
    });

    it('fetchVapidConfig throws on an error answer instead of reporting "no push configured"', async () => {
        mockFetchResponse(503);
        await expect(fetchVapidConfig()).rejects.toThrow('GET /sync/config 503');
    });

    it('fetchVapidConfig still reports a server without push keys as such', async () => {
        mockFetchResponse(200, { vapidPublicKey: null });
        await expect(fetchVapidConfig()).resolves.toEqual({ vapidPublicKey: null });
    });

    it('registerPushEndpoint throws on an error answer, so the step is retried', async () => {
        mockFetchResponse(500);
        await expect(registerPushEndpoint('device-1', subscription)).rejects.toThrow('POST /push/subscribe 500');
    });
});
