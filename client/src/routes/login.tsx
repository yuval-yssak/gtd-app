import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { authClient } from '../lib/authClient';

export const Route = createFileRoute('/login')({
    beforeLoad: async () => {
        const { data: session } = await authClient.getSession();
        if (session) {
            throw redirect({ to: '/' });
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
        <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: 'grey.100' }}>
            <Paper elevation={3} sx={{ p: 6, width: 360, textAlign: 'center' }}>
                <Typography variant="h5" fontWeight={600} mb={1}>
                    Getting Things Done
                </Typography>
                <Typography variant="body2" color="text.secondary" mb={4}>
                    Sign in to your account
                </Typography>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <Button variant="outlined" size="large" fullWidth onClick={signInWithGoogle}>
                        Sign in with Google
                    </Button>
                    <Button variant="outlined" size="large" fullWidth onClick={signInWithGitHub}>
                        Sign in with GitHub
                    </Button>
                </Box>
            </Paper>
        </Box>
    );
}
