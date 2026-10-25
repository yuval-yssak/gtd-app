import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/authClient', () => ({
    authClient: {
        getSession: vi.fn(),
        multiSession: { listDeviceSessions: vi.fn() },
    },
}));

import { authClient } from '../lib/authClient';
import { confirmSignedOutEverywhere } from '../routes/-authenticatedRouteGuard';

const LIVE = { data: { user: { id: 'user-a' }, session: { token: 'token-a' } } };
const DEAD = { data: null };

function serverReports(session: unknown, deviceSessions: unknown) {
    vi.mocked(authClient.getSession).mockResolvedValueOnce(session);
    vi.mocked(authClient.multiSession.listDeviceSessions).mockResolvedValueOnce(deviceSessions);
}

afterEach(() => {
    vi.resetAllMocks();
});

describe('confirmSignedOutEverywhere', () => {
    it('is false while the cookie session is live', async () => {
        serverReports(LIVE, { data: [] });
        expect(await confirmSignedOutEverywhere()).toBe(false);
    });

    it('is false when the session check cannot reach the server — offline is a valid state', async () => {
        vi.mocked(authClient.getSession).mockRejectedValueOnce(new TypeError('Failed to fetch'));
        expect(await confirmSignedOutEverywhere()).toBe(false);
    });

    it('is false when the cookie session is dead but another account on the device is still live', async () => {
        serverReports(DEAD, { data: [{ user: { id: 'user-b' }, session: { token: 'token-b' } }] });
        expect(await confirmSignedOutEverywhere()).toBe(false);
    });

    it('is false when the device-session list answers with an error (a 5xx or a rate limit) — fail open', async () => {
        serverReports(DEAD, { data: null, error: { status: 503, message: 'Service Unavailable' } });
        expect(await confirmSignedOutEverywhere()).toBe(false);
    });

    it('is false when the device-session list cannot reach the server', async () => {
        vi.mocked(authClient.getSession).mockResolvedValueOnce(DEAD);
        vi.mocked(authClient.multiSession.listDeviceSessions).mockRejectedValueOnce(new TypeError('Failed to fetch'));
        expect(await confirmSignedOutEverywhere()).toBe(false);
    });

    it('is true only when the server confirms no session at all on this device', async () => {
        serverReports(DEAD, { data: [] });
        expect(await confirmSignedOutEverywhere()).toBe(true);
    });
});
