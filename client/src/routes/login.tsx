import { createFileRoute, isRedirect, Link, redirect } from '@tanstack/react-router';
import { useState } from 'react';
import { Button, Card, Text } from '../designSystem';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { APP_NAME } from '../lib/appName';
import { authClient } from '../lib/authClient';
import type { OAuthProvider } from '../types/MyDB';
import styles from './-login.module.css';

export const Route = createFileRoute('/login')({
    beforeLoad: async () => {
        // Wrap in try/catch so an offline reload of /login doesn't crash the route with a
        // bare TypeError. When the network is down we simply render the sign-in page —
        // OAuth itself won't work anyway, but the shell stays visible.
        try {
            const { data: session } = await authClient.getSession();
            if (session) {
                throw redirect({ to: '/' });
            }
        } catch (e) {
            // Re-throw the redirect so the router still navigates to '/'; only swallow network errors.
            if (isRedirect(e)) throw e;
        }
    },
    component: LoginPage,
});

function LoginPage() {
    useDocumentTitle('Sign in');
    // Tracks which provider the user clicked. The happy path navigates the browser away
    // (component unmounts), but if the pre-redirect POST /auth/sign-in/social fetch rejects —
    // offline, 5xx, CORS — we reset pending and surface the error so the buttons aren't
    // permanently stuck.
    const [pendingProvider, setPendingProvider] = useState<OAuthProvider | null>(null);
    const [signInError, setSignInError] = useState<string | null>(null);

    function signIn(provider: OAuthProvider) {
        setPendingProvider(provider);
        setSignInError(null);
        authClient.signIn
            .social({
                provider,
                callbackURL: `${window.location.origin}/auth/callback`,
            })
            .catch((err) => {
                console.error('[login] signIn.social failed', err);
                setPendingProvider(null);
                setSignInError("Couldn't start sign-in. Check your connection and try again.");
            });
    }

    const isPending = pendingProvider !== null;

    return (
        <main className={styles.page}>
            <Card padding="none" className={styles.card}>
                <Text as="h1" variant="title" className={styles.appName}>
                    {APP_NAME}
                </Text>
                {/* A one-line description so the sign-in card is self-explanatory; the public homepage
                    Google's OAuth reviewers read is the landing page at / (routes/-LandingPage.tsx). */}
                <Text variant="bodySm" tone="secondary" className={styles.description} data-testid="loginAppDescription">
                    A personal productivity app for capturing, organising and reviewing your tasks — with offline-first sync across your devices and optional
                    Google Calendar integration.
                </Text>
                <Text variant="bodySm" tone="secondary" className={styles.prompt}>
                    Sign in to your account
                </Text>
                <div className={styles.buttonGroup}>
                    <Button variant="outline" size="lg" fullWidth onClick={() => signIn('google')} disabled={isPending} loading={pendingProvider === 'google'}>
                        {pendingProvider === 'google' ? 'Redirecting…' : 'Sign in with Google'}
                    </Button>
                    <Button variant="outline" size="lg" fullWidth onClick={() => signIn('github')} disabled={isPending} loading={pendingProvider === 'github'}>
                        {pendingProvider === 'github' ? 'Redirecting…' : 'Sign in with GitHub'}
                    </Button>
                </div>
                {signInError && (
                    <Text variant="bodySm" tone="error" className={styles.error} role="alert">
                        {signInError}
                    </Text>
                )}
                {/* Google's OAuth consent-screen review checks that the policy is reachable from the sign-in flow. */}
                <Text as="p" variant="caption" tone="secondary" className={styles.legalFooter}>
                    By signing in you agree to the{' '}
                    <Link to="/terms" data-testid="loginTermsLink">
                        Terms of Service
                    </Link>{' '}
                    and{' '}
                    <Link to="/privacy" data-testid="loginPrivacyLink">
                        Privacy Policy
                    </Link>
                    .
                </Text>
                <Text as="p" variant="caption" tone="secondary" className={styles.homeLink}>
                    <Link to="/" data-testid="loginHomeLink">
                        Home
                    </Link>
                </Text>
            </Card>
        </main>
    );
}
