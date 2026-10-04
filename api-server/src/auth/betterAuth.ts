import { betterAuth } from 'better-auth';
import { mongodbAdapter } from 'better-auth/adapters/mongodb';
import { multiSession } from 'better-auth/plugins';
import type { Db } from 'mongodb';
import { betterAuthSecret } from '../lib/betterAuthTokenCrypto.js';

export function createAuth(db: Db) {
    return betterAuth({
        baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:4000',
        basePath: '/auth', // mount point in index.ts is /auth/*, not the default /api/auth/*
        database: mongodbAdapter(db, {
            // transaction: false required for standalone MongoDB (dev uses a non-replica-set instance)
            transaction: false,
        }),
        trustedOrigins: [
            process.env.CLIENT_URL ?? 'http://localhost:4173',
            // vite preview serves on 4173; vite dev serves on 4173 — trust both in dev
            'http://localhost:4173',
            'http://localhost:5173',
        ],
        // One source of truth with lib/betterAuthTokenCrypto.ts, which decrypts the stored sign-in
        // tokens with the same secret during account deletion.
        secret: betterAuthSecret(),
        advanced: {
            useSecureCookies: process.env.NODE_ENV === 'production',
            // sameSite: 'none' required in prod — client (Cloudflare Pages) and API (Cloud Run) are on different domains
            defaultCookieAttributes:
                process.env.NODE_ENV === 'production'
                    ? { httpOnly: true, secure: true, sameSite: 'none' as const }
                    : { httpOnly: true, sameSite: 'lax' as const },
        },
        plugins: [
            // Allows multiple simultaneous server-side sessions (different user accounts
            // or devices) so "Add another account" never signs out the current user.
            multiSession(),
        ],
        account: {
            // Sign-in tokens Google/GitHub issue (`accessToken` + `refreshToken` on the `account`
            // collection) are encrypted at rest with `secret` (BETTER_AUTH_SECRET), as the privacy
            // policy states. Better Auth 1.5.6 leaves `idToken` (the signed OpenID profile JWT) in
            // plaintext — it grants no API access, but it is PII, so revisit when the library covers it.
            // Better Auth reads mixed rows: a value that does not look like ciphertext is returned
            // verbatim, so rows written before this flag stay valid until
            // `scripts/encryptBetterAuthTokens.ts` (or the user's next sign-in) re-encrypts them.
            // Consequence: rotating BETTER_AUTH_SECRET now also makes every stored sign-in token
            // unreadable (not just every session cookie) — see assertSessionSecretConfiguredInProduction.
            encryptOAuthTokens: true,
            // Link OAuth accounts with matching emails (e.g. Google + GitHub same address → one user)
            accountLinking: {
                enabled: true,
                trustedProviders: ['google', 'github'],
            },
        },
        socialProviders: {
            google: {
                clientId: process.env.GOOGLE_OAUTH_APP_CLIENT_ID ?? '',
                clientSecret: process.env.GOOGLE_OAUTH_APP_CLIENT_SECRET ?? '',
            },
            github: {
                clientId: process.env.GITHUB_CLIENT_ID ?? '',
                clientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
            },
        },
    });
}

export type Auth = ReturnType<typeof createAuth>;
