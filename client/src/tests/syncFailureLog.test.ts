import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionUserMismatchError } from '../api/sessionUserMismatchError';
import { logSyncFailure } from '../lib/syncFailureLog';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('logSyncFailure', () => {
    it('logs a session switched to another account as expected, not as an error', () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        logSyncFailure('[sync] catch-up pull failed', new SessionUserMismatchError('GET /sync/pull'));

        expect(errorSpy).not.toHaveBeenCalled();
        expect(logSpy).toHaveBeenCalledWith('[sync] catch-up pull failed', expect.objectContaining({ reason: expect.any(String) }));
    });

    it('logs any other failure as an error', () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const failure = new Error('GET /sync/pull 503');

        logSyncFailure('[sync] catch-up pull failed', failure);

        expect(errorSpy).toHaveBeenCalledWith('[sync] catch-up pull failed', failure);
    });
});
