import { redirect } from '@tanstack/router-core';
import type { IDBPDatabase } from 'idb';
import { getActiveAccount } from '../db/accountHelpers';
import type { MyDB } from '../types/MyDB';
import { fetchSessionSafely } from './_authenticated';

export async function authenticatedRouteGuard({ context }: { context: { db: IDBPDatabase<MyDB> } }) {
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
}
