import { SessionUserMismatchError } from '../api/sessionUserMismatchError';

/**
 * A session that switched to another account mid-sync (412) is an expected race on a multi-account
 * device — the next pass retries — so it is not logged as an error.
 */
export function logSyncFailure(context: string, err: unknown): void {
    if (err instanceof SessionUserMismatchError) {
        console.log(context, { reason: 'session switched to another account; the next pass retries' });
        return;
    }
    console.error(context, err);
}
