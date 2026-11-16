/**
 * Thrown when a sync request answers 412 `{ error: 'session_user_mismatch' }`: the session cookie
 * resolved to a different account than the one being synced (another pass switched the active
 * session mid-sync on a multi-account device). Nothing was read or written; the next pass retries.
 *
 * Its own module for the same reason as SyncAuthError: syncClient.mock.ts re-exports it un-mocked.
 */
export class SessionUserMismatchError extends Error {
    constructor(context: string) {
        super(`${context} 412 session_user_mismatch`);
        this.name = 'SessionUserMismatchError';
    }
}
