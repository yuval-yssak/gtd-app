import { afterEach, describe, expect, it, vi } from 'vitest';
import { BootstrapRequiredError, fetchBootstrap, fetchDeviceStatus, fetchSyncOps, pushSyncOps, SyncAuthError } from '../api/syncClient';

function mockFetchResponse(status: number, body: unknown = {}): void {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }));
}

afterEach(() => {
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
        await expect(fetchSyncOps('2025-01-01T00:00:00.000Z', '', '2025-01-01T00:00:00.000Z', '', 'device-1')).rejects.toBeInstanceOf(SyncAuthError);
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

describe('syncClient — reaped-device signals', () => {
    it('fetchSyncOps throws BootstrapRequiredError on 409 (device row missing server-side)', async () => {
        mockFetchResponse(409, { bootstrapRequired: true });
        await expect(fetchSyncOps('2025-01-01T00:00:00.000Z', '', '2025-01-01T00:00:00.000Z', '', 'device-1')).rejects.toBeInstanceOf(BootstrapRequiredError);
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
