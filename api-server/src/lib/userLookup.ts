import { ObjectId } from 'mongodb';
import { db } from '../loaders/mainLoader.js';

/**
 * Reads a user's email from the Better Auth `user` collection. There is no `UsersDAO` — Better
 * Auth owns the `user` collection — so this thin helper centralizes the lookup.
 *
 * Better Auth's mongodbAdapter stores `_id` as an `ObjectId` whose hex string equals the `id`
 * field that `auth.api.getSession()` returns. Test fixtures (e.g. `tests/reassign.test.ts`) seed
 * user rows with arbitrary string `_id`s. We accept both shapes by trying ObjectId first when
 * the userId is a valid ObjectId hex, then falling back to the raw string. Returns `null` if the
 * user no longer exists (e.g. account deleted between integration creation and escalation).
 */
export async function getUserEmail(userId: string): Promise<string | null> {
    const doc = await findUserById(userId);
    return doc?.email ?? null;
}

/** Shape of the Better Auth `user` row the lookups below project. */
export interface BetterAuthUserRow {
    _id: unknown;
    email?: string;
    name?: string;
    image?: string | null;
}

export async function findUserById(userId: string): Promise<BetterAuthUserRow | null> {
    const collection = db.collection<BetterAuthUserRow>('user');
    if (ObjectId.isValid(userId) && /^[a-f0-9]{24}$/i.test(userId)) {
        const byOid = await collection.findOne({ _id: new ObjectId(userId) } as never);
        if (byOid) {
            return byOid;
        }
    }
    return collection.findOne({ _id: userId } as never);
}

/**
 * Resolves a user's id from their email, as the string form that every user-scoped collection
 * stores (`String(ObjectId)` === the `id` Better Auth hands out). Emails are stored lowercased.
 */
export async function findUserIdByEmail(email: string): Promise<string | null> {
    const doc = await db.collection<BetterAuthUserRow>('user').findOne({ email: email.toLowerCase() });
    return doc ? String(doc._id) : null;
}
