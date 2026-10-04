/**
 * Best-effort revocation of a Google OAuth grant (`https://oauth2.googleapis.com/revoke`).
 *
 * Shared by the calendar disconnect handler and account deletion: both delete our copy of the
 * tokens, and the privacy policy says that ends our access — which is only true at Google's end
 * once the grant itself is revoked. Revoking the refresh token (or, failing that, the access
 * token) invalidates EVERY token Google issued for this app + this Google account, including
 * the Better Auth sign-in `account` tokens when the same Google account was used to sign in.
 * That is acceptable for the SAME user: sign-in sessions are cookie-based and never read those
 * tokens, and the next sign-in mints fresh ones. It is NOT acceptable across users — callers skip
 * the revocation when another GTD user has connected the same Google account
 * (`calendarIntegrationsDAO.isGoogleAccountUsedByOtherUser`).
 *
 * Never throws and never blocks the caller for long: the grant may already be gone (Google
 * answers 400 `invalid_token`), the network may be down, or the token may be a dev placeholder.
 */

export const GOOGLE_TOKEN_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

/** Google normally answers in well under a second; a disconnect must not hang on a stalled socket. */
const REVOKE_TIMEOUT_MS = 5_000;

/**
 * `already_revoked`: Google answered 400 `invalid_token` — the grant is already gone. Routine when
 * the calendar integration and the Google sign-in share one grant (same client id + same Google
 * account): revoking the first kills the second. The goal state holds, so it is not a failure.
 */
export type GoogleTokenRevokeOutcome = 'revoked' | 'already_revoked' | 'failed' | 'skipped';

/** Picks the token whose revocation kills the whole grant: the refresh token when we hold one. */
export function pickTokenToRevoke(tokens: { refreshToken?: string | null; accessToken?: string | null }): string | null {
    return tokens.refreshToken || tokens.accessToken || null;
}

export async function revokeGoogleToken(token: string | null): Promise<GoogleTokenRevokeOutcome> {
    if (!token) {
        return 'skipped';
    }
    try {
        const response = await fetch(GOOGLE_TOKEN_REVOKE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token }),
            signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
        });
        if (response.ok) {
            return 'revoked';
        }
        if (response.status === 400) {
            console.log('[google-revoke] token already invalid at Google — nothing left to revoke');
            return 'already_revoked';
        }
        console.warn(`[google-revoke] Google rejected the revocation | status=${response.status}`);
        return 'failed';
    } catch (err) {
        console.warn('[google-revoke] revocation request failed', err);
        return 'failed';
    }
}

/** Revokes the grant behind a decrypted calendar integration. Same best-effort contract as `revokeGoogleToken`. */
export async function revokeGoogleGrant(tokens: { refreshToken?: string | null; accessToken?: string | null }): Promise<GoogleTokenRevokeOutcome> {
    return revokeGoogleToken(pickTokenToRevoke(tokens));
}
