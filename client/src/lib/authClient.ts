import { multiSessionClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import { fetchWithHeadersDeadline } from '../api/deadlineSignal';
import { API_SERVER } from '../constants/globals';

/**
 * Every auth call gives up if the server has not started answering by then. On a network that never
 * answers the browser would otherwise hold the request for minutes, and the boot sequence, the live
 * channels and each catch-up retry waited behind the account list or the session check. Kept under
 * the session gate's 10s timeout: an auth call made inside the gate (session check, switching the
 * active session) must not outlive it and land in the middle of the next pass.
 */
export const AUTH_HEADERS_DEADLINE_MS = 8_000;

// Single shared instance — better-auth/react manages session caching internally.
// basePath must match the server's mount point (/auth/*); without it the client
// defaults to /api/auth/* which doesn't exist on this server.
export const authClient = createAuthClient({
    baseURL: API_SERVER,
    basePath: '/auth',
    plugins: [multiSessionClient()],
    // Look `fetch` up per request rather than capturing it at creation, so a stubbed fetch (Storybook's
    // offline API, tests) reaches the auth calls too.
    fetchOptions: { customFetchImpl: (input, init) => fetchWithHeadersDeadline(input, { ...init, deadlineMs: AUTH_HEADERS_DEADLINE_MS }) },
});
