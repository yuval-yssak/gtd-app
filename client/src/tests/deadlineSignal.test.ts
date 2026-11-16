import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithHeadersDeadline } from '../api/deadlineSignal';
import { AUTH_HEADERS_DEADLINE_MS, authClient } from '../lib/authClient';

/** A network that never answers ("lie-fi"), but honours an abort the way the browser's fetch does. */
function stubHangingFetch() {
    const fetchSpy = vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
                // Like the browser: an already-aborted signal rejects at once, a later abort when it fires.
                if (init?.signal?.aborted) {
                    reject(init.signal.reason);
                    return;
                }
                init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
            }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    return fetchSpy;
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('fetchWithHeadersDeadline', () => {
    it('aborts at once when the caller has already given up', async () => {
        stubHangingFetch();
        const caller = new AbortController();
        caller.abort(new Error('caller gave up before the call'));

        await expect(fetchWithHeadersDeadline('https://api.example/x', { signal: caller.signal, deadlineMs: 60_000 })).rejects.toThrow(
            'caller gave up before the call',
        );
    });

    it("stops listening to the caller's signal once the response arrived", async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('{}', { status: 200 })),
        );
        const caller = new AbortController();
        const removeSpy = vi.spyOn(caller.signal, 'removeEventListener');

        await fetchWithHeadersDeadline('https://api.example/x', { signal: caller.signal, deadlineMs: 60_000 });

        expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    });

    it("still honours the caller's own abort signal", async () => {
        stubHangingFetch();
        const caller = new AbortController();

        const request = fetchWithHeadersDeadline('https://api.example/x', { signal: caller.signal, deadlineMs: 60_000 });
        caller.abort(new Error('caller gave up'));

        await expect(request).rejects.toThrow('caller gave up');
    });
});

// Every Better Auth call (the account list, getSession, switching the active session) used to wait
// as long as the browser held a hanging request — minutes — and the boot sequence, the live
// channels and every catch-up retry waited behind it.
describe('authClient on a network that never answers', () => {
    it('gives up on a call once its headers deadline passes', async () => {
        stubHangingFetch();

        const settled = authClient.getSession().then(
            (result) => result,
            (err: unknown) => ({ thrown: err }),
        );
        await vi.advanceTimersByTimeAsync(AUTH_HEADERS_DEADLINE_MS);

        // better-fetch rethrows a failed fetch (it returns `{ error }` only for an HTTP error answer).
        const outcome = await settled;
        expect(outcome).toHaveProperty('thrown');
        expect(String((outcome as { thrown: unknown }).thrown)).toContain(`No answer within ${AUTH_HEADERS_DEADLINE_MS}ms`);
    });
});
