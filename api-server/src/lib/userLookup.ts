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

async function findUserById(userId: string): Promise<{ email?: string } | null> {
    const collection = db.collection<{ email?: string }>('user');
    if (ObjectId.isValid(userId) && /^[a-f0-9]{24}$/i.test(userId)) {
        const byOid = await collection.findOne({ _id: new ObjectId(userId) } as never, { projection: { email: 1 } });
        if (byOid) return byOid;
    }
    return collection.findOne({ _id: userId } as never, { projection: { email: 1 } });
}
