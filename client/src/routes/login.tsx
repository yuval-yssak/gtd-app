import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { createFileRoute, isRedirect, redirect } from '@tanstack/react-router';
import { authClient } from '../lib/authClient';
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
    function signInWithGoogle() {
        // void: signIn.social() redirects the browser; we intentionally discard the promise
        void authClient.signIn.social({
            provider: 'google',
            callbackURL: `${window.location.origin}/auth/callback`,
        });
    }

    function signInWithGitHub() {
        // void: same as above
        void authClient.signIn.social({
            provider: 'github',
            callbackURL: `${window.location.origin}/auth/callback`,
        });
    }

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
                    <Button variant="outlined" size="large" fullWidth onClick={signInWithGoogle}>
                        Sign in with Google
                    </Button>
                    <Button variant="outlined" size="large" fullWidth onClick={signInWithGitHub}>
                        Sign in with GitHub
                    </Button>
                </div>
            </Paper>
        </div>
    );
}
