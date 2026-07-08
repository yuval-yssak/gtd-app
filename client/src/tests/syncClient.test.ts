import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBootstrap, fetchSyncOps, pushSyncOps, SyncAuthError } from '../api/syncClient';

function mockFetchResponse(status: number): void {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve({}) }));
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
