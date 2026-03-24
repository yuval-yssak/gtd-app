import { betterAuth } from 'better-auth';
import { multiSession } from 'better-auth/plugins';
import { mongodbAdapter } from 'better-auth/adapters/mongodb';
import type { Db } from 'mongodb';

export function createAuth(db: Db) {
    return betterAuth({
        baseURL: process.env['BETTER_AUTH_URL'] ?? 'http://localhost:4000',
        basePath: '/auth', // mount point in index.ts is /auth/*, not the default /api/auth/*
        database: mongodbAdapter(db, {
            // transaction: false required for standalone MongoDB (dev uses a non-replica-set instance)
            transaction: false,
        }),
        trustedOrigins: [
            process.env['CLIENT_URL'] ?? 'http://localhost:5173',
            // vite preview serves on 4173; vite dev serves on 5173 — trust both in dev
            'http://localhost:4173',
            'http://localhost:5173',
        ],
        secret: process.env['BETTER_AUTH_SECRET'] ?? 'dev_better_auth_secret_change_in_production',
        advanced: {
            useSecureCookies: process.env['NODE_ENV'] === 'production',
            // sameSite: 'none' required in prod — client (Cloudflare Pages) and API (Cloud Run) are on different domains
            defaultCookieAttributes:
                process.env['NODE_ENV'] === 'production'
                    ? { httpOnly: true, secure: true, sameSite: 'none' as const }
                    : { httpOnly: true, sameSite: 'lax' as const },
        },
        plugins: [
            // Allows multiple simultaneous server-side sessions (different user accounts
            // or devices) so "Add another account" never signs out the current user.
            multiSession(),
        ],
        account: {
            // Link OAuth accounts with matching emails (e.g. Google + GitHub same address → one user)
            accountLinking: {
                enabled: true,
                trustedProviders: ['google', 'github'],
            },
        },
        socialProviders: {
            google: {
                clientId: process.env['GOOGLE_OAUTH_APP_CLIENT_ID'] ?? '',
                clientSecret: process.env['GOOGLE_OAUTH_APP_CLIENT_SECRET'] ?? '',
            },
            github: {
                clientId: process.env['GITHUB_CLIENT_ID'] ?? '',
                clientSecret: process.env['GITHUB_CLIENT_SECRET'] ?? '',
            },
        },
    });
}

export type Auth = ReturnType<typeof createAuth>;
