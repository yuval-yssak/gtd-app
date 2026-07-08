/**
 * Thrown instead of a generic `Error` when a sync request comes back 401 — i.e. the Better Auth
 * session cookie has expired or gone stale. Callers that know which userId a request was for catch
 * this specifically to flag that account for reauth (see `dispatchAccountNeedsReauth`) rather than
 * retrying forever against a dead cookie.
 *
 * Kept in its own module (not defined in syncClient.ts) so syncClient.mock.ts can import it without
 * pulling in the real syncClient.ts module — vi.mock('#api/syncClient', ...) swaps the whole module,
 * so a mock that re-exports from its own real counterpart mid-mock can wedge module resolution.
 */
export class SyncAuthError extends Error {
    constructor(context: string) {
        super(`${context} 401`);
        this.name = 'SyncAuthError';
    }
}
