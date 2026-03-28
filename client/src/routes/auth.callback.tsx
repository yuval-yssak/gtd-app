import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import { createFileRoute, redirect } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { setActiveAccount, upsertAccount } from '../db/accountHelpers';
import { authClient } from '../lib/authClient';
import type { OAuthProvider } from '../types/MyDB';

export const Route = createFileRoute('/auth/callback')({
    beforeLoad: async ({ context: { db } }) => {
        const { data: session } = await authClient.getSession();

        if (!session) {
            // OAuth failed or cookie was not set — send back to login
            throw redirect({ to: '/login' });
        }

        await upsertAccount(
            {
                id: session.user.id,
                email: session.user.email,
                name: session.user.name,
                // better-auth may return null or undefined; normalize to null
                image: session.user.image ?? null,
                // Better Auth doesn't expose the provider on the session user directly;
                // derive it from accounts list if possible, default to 'google'
                provider: (session.user as { provider?: OAuthProvider }).provider ?? 'google',
                addedAt: dayjs().valueOf(),
            },
            db,
        );
        await setActiveAccount(session.user.id, db);

        throw redirect({ to: '/' });
    },
    component: CallbackPage,
});

function CallbackPage() {
    return (
        <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <CircularProgress />
        </Box>
    );
}
