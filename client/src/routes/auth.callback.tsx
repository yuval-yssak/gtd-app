import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { announceAccountReauthResolved } from '../contexts/accountReauthEvents';
import { hydrateAccountFromSession } from '../db/accountHelpers';
import { authClient } from '../lib/authClient';
import styles from './-auth.callback.module.css';

export const Route = createFileRoute('/auth/callback')({
    beforeLoad: async ({ context: { db } }) => {
        const { data: session } = await authClient.getSession();
        if (!session) {
            // OAuth failed or cookie was not set — send back to login
            throw redirect({ to: '/login' });
        }
        await hydrateAccountFromSession(db, session);
        // A completed OAuth login means this account can sync again — tell every OTHER open tab to
        // drop its stale "Sync is broken" dialog/banner. This tab's own store is already fresh
        // (the OAuth redirect reloaded the page), so only the cross-tab signal matters here.
        announceAccountReauthResolved(session.user.id);
        throw redirect({ to: '/' });
    },
    component: CallbackPage,
});

function CallbackPage() {
    return (
        <Box className={styles.callbackPage}>
            <CircularProgress />
        </Box>
    );
}
