import { afterEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_TOKEN_REVOKE_URL, pickTokenToRevoke, revokeGoogleGrant, revokeGoogleToken } from '../lib/googleTokenRevoke.js';

afterEach(() => {
    vi.restoreAllMocks();
});

function stubFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(impl as typeof fetch);
}

describe('revokeGoogleToken', () => {
    it('POSTs the token as a form body to Google’s revoke endpoint and reports success', async () => {
        const fetchSpy = stubFetch(async () => new Response('', { status: 200 }));
        await expect(revokeGoogleToken('rt-1')).resolves.toBe('revoked');
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [call] = fetchSpy.mock.calls;
        if (!call) {
            throw new Error('expected one fetch call');
        }
        const [url, init] = call;
        expect(url).toBe(GOOGLE_TOKEN_REVOKE_URL);
        expect(init?.method).toBe('POST');
        expect(String(init?.body)).toBe('token=rt-1');
        expect(new Headers(init?.headers).get('content-type')).toBe('application/x-www-form-urlencoded');
    });

    it('reports already_revoked when Google answers 400 — the grant is gone, which is the goal state', async () => {
        stubFetch(async () => new Response('{"error":"invalid_token"}', { status: 400 }));
        await expect(revokeGoogleToken('already-gone')).resolves.toBe('already_revoked');
    });

    it('reports failure (and never throws) on any other rejection from Google', async () => {
        stubFetch(async () => new Response('', { status: 503 }));
        await expect(revokeGoogleToken('rt')).resolves.toBe('failed');
    });

    it('reports failure (and never throws) when the request itself fails', async () => {
        stubFetch(async () => {
            throw new TypeError('fetch failed');
        });
        await expect(revokeGoogleToken('rt')).resolves.toBe('failed');
    });

    it('skips without a network call when there is no token', async () => {
        const fetchSpy = stubFetch(async () => new Response('', { status: 200 }));
        await expect(revokeGoogleToken(null)).resolves.toBe('skipped');
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});

describe('pickTokenToRevoke / revokeGoogleGrant', () => {
    it('prefers the refresh token — revoking it kills the whole grant', () => {
        expect(pickTokenToRevoke({ refreshToken: 'rt', accessToken: 'at' })).toBe('rt');
    });

    it('falls back to the access token when no refresh token is held', () => {
        expect(pickTokenToRevoke({ refreshToken: '', accessToken: 'at' })).toBe('at');
        expect(pickTokenToRevoke({ accessToken: null })).toBeNull();
    });

    it('revokeGoogleGrant sends the picked token', async () => {
        const fetchSpy = stubFetch(async () => new Response('', { status: 200 }));
        await expect(revokeGoogleGrant({ refreshToken: 'integration-rt', accessToken: 'integration-at' })).resolves.toBe('revoked');
        const [call] = fetchSpy.mock.calls;
        if (!call) {
            throw new Error('expected one fetch call');
        }
        expect(String(call[1]?.body)).toBe('token=integration-rt');
    });
});
