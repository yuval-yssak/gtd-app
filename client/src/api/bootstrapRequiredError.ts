/**
 * Thrown when `GET /sync/pull` returns 409 `{ bootstrapRequired: true }` — the server has no
 * `deviceSyncState` row for this (device, user) pair, meaning the device was reaped after >30 days
 * offline and ops it never pulled may already be purged. The local cursor is worthless; this
 * device MUST run a full bootstrap for that user (see db/syncRecovery.ts for the recovery flow).
 *
 * Kept in its own module (not defined in syncClient.ts) for the same reason as SyncAuthError:
 * syncClient.mock.ts re-exports it un-mocked, and re-exporting a value from the real module being
 * mocked would pull its runtime code into the mock's module graph and wedge Vitest's resolution.
 */
export class BootstrapRequiredError extends Error {
    constructor(context: string) {
        super(`${context} 409 bootstrapRequired`);
        this.name = 'BootstrapRequiredError';
    }
}
