import { createFileRoute } from '@tanstack/react-router';
import { redirect } from '@tanstack/router-core';
import { getActiveAccount } from '../db/accountHelpers';
import { AuthenticatedLayout, fetchSessionSafely } from './_authenticated';

export const Route = createFileRoute('/Route')({
    beforeLoad: async ({ context }) => {
        const { db } = context;
        const { session, networkError } = await fetchSessionSafely();

        if (!networkError && !session) {
            // Server responded but session is gone — must re-authenticate
            throw redirect({ to: '/login' });
        }

        if (networkError) {
            // Offline: allow through only if this device has a cached account,
            // meaning the user previously authenticated on this device.
            const activeAccount = await getActiveAccount(db);
            if (!activeAccount) {
                throw redirect({ to: '/login' });
            }
            return { session: null };
        }

        return { session };
    },
    component: AuthenticatedLayout,
});
