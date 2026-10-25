import { multiSessionClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import { API_SERVER } from '../constants/globals';

// Single shared instance — better-auth/react manages session caching internally.
// basePath must match the server's mount point (/auth/*); without it the client
// defaults to /api/auth/* which doesn't exist on this server.
export const authClient = createAuthClient({
    baseURL: API_SERVER,
    basePath: '/auth',
    plugins: [multiSessionClient()],
    // Look `fetch` up per request rather than capturing it at creation, so a stubbed fetch (Storybook's
    // offline API, tests) reaches the auth calls too.
    fetchOptions: { customFetchImpl: (input, init) => fetch(input, init) },
});
