import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { createFileRoute, isRedirect, redirect } from '@tanstack/react-router';
import { useState } from 'react';
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
        <div className={styles.page}>
            <Paper elevation={3} className={styles.card}>
                <Typography
                    variant="h5"
                    sx={{
                        fontWeight: 600,
                        mb: 1,
                    }}
                >
                    Getting Things Done
                </Typography>
                <Typography
                    variant="body2"
                    sx={{
                        color: 'text.secondary',
                        mb: 4,
                    }}
                >
                    Sign in to your account
                </Typography>
                <div className={styles.buttonGroup}>
                    <Button
                        variant="outlined"
                        size="large"
                        fullWidth
                        onClick={() => signIn('google')}
                        disabled={isPending}
                        startIcon={pendingProvider === 'google' ? <CircularProgress size={16} /> : null}
                    >
                        {pendingProvider === 'google' ? 'Redirecting…' : 'Sign in with Google'}
                    </Button>
                    <Button
                        variant="outlined"
                        size="large"
                        fullWidth
                        onClick={() => signIn('github')}
                        disabled={isPending}
                        startIcon={pendingProvider === 'github' ? <CircularProgress size={16} /> : null}
                    >
                        {pendingProvider === 'github' ? 'Redirecting…' : 'Sign in with GitHub'}
                    </Button>
                </div>
                {signInError && (
                    <Typography variant="body2" color="error" sx={{ mt: 2 }} role="alert">
                        {signInError}
                    </Typography>
                )}
            </Paper>
        </div>
    );
}
