import { AccountApiError, SESSION_MISMATCH_CODE } from '#api/accountApi';
import type { StoredAccount } from '../../types/MyDB';

/**
 * The typed confirmation must match the account email — trimmed and case-insensitive, since email
 * addresses are case-insensitive in practice and a stray space must not block a deliberate user.
 */
export function isDeleteConfirmationValid(typed: string, accountEmail: string): boolean {
    const normalizedTyped = typed.trim().toLowerCase();
    return normalizedTyped.length > 0 && normalizedTyped === accountEmail.trim().toLowerCase();
}

export const SESSION_MISMATCH_MESSAGE = "This device's session points at a different account — reload and try again.";

export type AccountDeletionResult = { kind: 'deleted' } | { kind: 'mismatch'; message: string } | { kind: 'failed'; message: string };

export interface AccountDeletionDeps {
    account: Pick<StoredAccount, 'id'>;
    deleteMyAccount: (expectedUserId: string) => Promise<{ deletedUserId: string }>;
    /** Pins the cookie session to the active account for the duration of the server call (AppData.withActiveAccountSession). */
    withActiveAccountSession: <T>(task: () => Promise<T>) => Promise<T>;
    /** Local wipe + recovery (evaporateUserAndRecoverGated). Runs OUTSIDE the session pivot — see below. */
    evaporate: (userId: string) => Promise<unknown>;
}

export function describeError(err: unknown, fallback: string): string {
    return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * Self-service deletion, as a pure orchestration so the branches are unit-testable without React:
 *   1. `DELETE /auth/me?expectedUserId=` under the active account's pivoted session — a 409
 *      `session_mismatch` (cookie drifted to another signed-in account) deletes nothing.
 *   2. Evaporate the account the server actually deleted. Deliberately outside the
 *      `withActiveAccountSession` callback: that wrapper holds the session gate and its `finally`
 *      restores the previous session, which is dead once the delete succeeded — and the evaporation
 *      itself takes the gate.
 *   3. If the server reports a different `deletedUserId` than the UI asked for (defence in depth
 *      behind the expectedUserId guard), evaporate THAT account and surface it as a mismatch rather
 *      than wiping the still-existing one.
 */
export async function runAccountDeletion({
    account,
    deleteMyAccount,
    withActiveAccountSession,
    evaporate,
}: AccountDeletionDeps): Promise<AccountDeletionResult> {
    const outcome = await requestServerDeletion(account.id, deleteMyAccount, withActiveAccountSession);
    if (outcome.kind !== 'deleted') {
        return outcome;
    }
    await evaporate(outcome.deletedUserId);
    if (outcome.deletedUserId !== account.id) {
        return { kind: 'mismatch', message: SESSION_MISMATCH_MESSAGE };
    }
    return { kind: 'deleted' };
}

async function requestServerDeletion(
    expectedUserId: string,
    deleteMyAccount: AccountDeletionDeps['deleteMyAccount'],
    withActiveAccountSession: AccountDeletionDeps['withActiveAccountSession'],
): Promise<{ kind: 'deleted'; deletedUserId: string } | Exclude<AccountDeletionResult, { kind: 'deleted' }>> {
    try {
        const { deletedUserId } = await withActiveAccountSession(() => deleteMyAccount(expectedUserId));
        return { kind: 'deleted', deletedUserId };
    } catch (err) {
        if (err instanceof AccountApiError && err.code === SESSION_MISMATCH_CODE) {
            return { kind: 'mismatch', message: SESSION_MISMATCH_MESSAGE };
        }
        return { kind: 'failed', message: describeError(err, "Couldn't delete the account. Please try again.") };
    }
}
