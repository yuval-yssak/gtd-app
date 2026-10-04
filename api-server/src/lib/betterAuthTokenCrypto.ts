import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';

/**
 * Better Auth encrypts the sign-in tokens it stores on `account` rows (`accessToken` and
 * `refreshToken`; `idToken` stays plaintext in 1.5.6) with `BETTER_AUTH_SECRET` once `account.encryptOAuthTokens` is on
 * (see `auth/betterAuth.ts`). It reads mixed rows fine — a value that does not look encrypted is
 * returned as-is — so rows written before the flag stay readable until they are re-encrypted by
 * `scripts/encryptBetterAuthTokens.ts` or the next sign-in. These helpers mirror Better Auth's
 * own `isLikelyEncrypted` / key choice so the deletion flow and the migration script agree with
 * the library about which values are ciphertext.
 */

export const DEV_BETTER_AUTH_SECRET = 'dev_better_auth_secret_change_in_production';

export function betterAuthSecret(): string {
    return process.env.BETTER_AUTH_SECRET ?? DEV_BETTER_AUTH_SECRET;
}

/** Mirrors Better Auth's heuristic: a `$ba$` envelope, or legacy bare hex ciphertext. */
export function isLikelyEncryptedToken(token: string): boolean {
    if (token.startsWith('$ba$')) {
        return true;
    }
    return token.length % 2 === 0 && /^[0-9a-f]+$/i.test(token);
}

export async function encryptBetterAuthToken(plaintext: string): Promise<string> {
    return symmetricEncrypt({ key: betterAuthSecret(), data: plaintext });
}

/** Returns the plaintext token whether the stored value is ciphertext or a pre-flag plaintext row. */
export async function readBetterAuthToken(stored: string | null | undefined): Promise<string | null> {
    if (!stored) {
        return null;
    }
    if (!isLikelyEncryptedToken(stored)) {
        return stored;
    }
    try {
        return await symmetricDecrypt({ key: betterAuthSecret(), data: stored });
    } catch (err) {
        // A hex-looking plaintext token (possible, if unlikely) or a secret rotation — the token
        // is unreadable either way, so the caller skips it rather than aborting its job.
        console.warn('[better-auth-crypto] stored token could not be decrypted', err);
        return null;
    }
}
