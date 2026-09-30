import { createFileRoute, redirect } from '@tanstack/react-router';
import { getActiveAccount } from '../db/accountHelpers';
import { recoverAccountFromServerSession } from './-authenticatedRouteGuard';
import { LandingPage } from './-LandingPage';

/**
 * `/` is public: signed-in visitors go straight to the inbox (the GTD entry point), everyone else
 * sees the landing page. It used to live under `_authenticated/`, whose guard redirected
 * signed-out visitors to /login — which Google's OAuth verification rejected as a homepage
 * "behind a login page".
 */
export const Route = createFileRoute('/')({
    beforeLoad: async ({ context: { db } }) => {
        // The server-session fallback matters here as much as in the guard: /login redirects a
        // cookie-only visitor (site data cleared) to '/', and without it they would see the
        // landing page whose Sign in button sends them back to /login — a dead loop.
        const isSignedIn = (await getActiveAccount(db)) !== undefined || (await recoverAccountFromServerSession(db));
        if (isSignedIn) {
            throw redirect({ to: '/inbox' });
        }
    },
    component: LandingPage,
});
