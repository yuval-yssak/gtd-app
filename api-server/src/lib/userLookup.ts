import { db } from '../loaders/mainLoader.js';

/**
 * Reads a user's email from the Better Auth `user` collection. There is no `UsersDAO` — Better
 * Auth owns the `user` collection — so this thin helper centralizes the lookup. Returns `null` if
 * the user no longer exists (e.g. account deleted between integration creation and escalation).
 */
export async function getUserEmail(userId: string): Promise<string | null> {
    const doc = await db.collection('user').findOne({ _id: userId } as never, { projection: { email: 1 } });
    return (doc as { email?: string } | null)?.email ?? null;
}
