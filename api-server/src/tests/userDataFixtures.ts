/**
 * One minimal row per user-scoped collection, written under a given owner — the test-side statement
 * of each collection's owner field, shared by the inventory test (filters match exactly these rows)
 * and the deletion test (every one of them must vanish). Kept apart from `lib/userDataInventory.ts`
 * on purpose: when the two disagree, one of them is wrong, and a collection missing here fails the
 * inventory's "fixture for every collection" check by name.
 */
import dayjs from 'dayjs';
import { type Document, ObjectId } from 'mongodb';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import { encryptBetterAuthToken } from '../lib/betterAuthTokenCrypto.js';
import type { UserIdentity } from '../lib/userDataInventory.js';
import { db } from '../loaders/mainLoader.js';

export interface FixtureOwner extends UserIdentity {
    /** Better Auth stores OAuth-created ids as ObjectId; set true to seed `user`/`session`/`account` in that shape. */
    betterAuthIdAsObjectId?: boolean;
}

function betterAuthId(owner: FixtureOwner): string | ObjectId {
    return owner.betterAuthIdAsObjectId ? new ObjectId(owner.userId) : owner.userId;
}

/** Synchronous fixtures; `account` is seeded separately because its tokens are encrypted asynchronously. */
export const USER_DATA_FIXTURES: Record<string, (owner: FixtureOwner) => Document> = {
    items: (o) => ({ user: o.userId, status: 'inbox', title: 'i', createdTs: dayjs().toISOString(), updatedTs: dayjs().toISOString() }),
    routines: (o) => ({ user: o.userId, title: 'r' }),
    people: (o) => ({ user: o.userId, name: 'p' }),
    workContexts: (o) => ({ user: o.userId, name: 'w' }),
    reviewInboxes: (o) => ({ user: o.userId, name: 'ri' }),
    itemBriefs: (o) => ({ user: o.userId, itemId: 'i', text: null }),
    operations: (o) => ({ user: o.userId, entityType: 'item', opType: 'update', ts: dayjs().toISOString() }),
    deviceSyncState: (o) => ({ user: o.userId, deviceId: `dev-${o.userId}` }),
    deviceUsers: (o) => ({ userId: o.userId, deviceId: `dev-${o.userId}` }),
    entityMoves: (o) => ({ entityId: `e-${o.userId}`, fromUserId: o.userId, toUserId: 'someone-else' }),
    pushSubscriptions: (o) => ({ _id: `dev-${o.userId}`, user: o.userId, endpoint: 'https://push.test/x', keys: { p256dh: 'k', auth: 'a' } }),
    sentEmails: (o) => ({ userId: o.userId, to: o.email, subject: 's' }),
    calendarIntegrations: (o) => ({ _id: `int-${o.userId}`, user: o.userId, provider: 'google', accessToken: 'enc-at', refreshToken: 'enc-rt' }),
    calendarSyncConfigs: (o) => ({
        user: o.userId,
        integrationId: `int-${o.userId}`,
        calendarId: 'primary',
        syncToken: 'tok',
        webhookChannelId: `chan-${o.userId}`,
        webhookResourceId: `res-${o.userId}`,
    }),
    apiTokens: (o) => ({ user: o.userId, tokenHash: `hash-${o.userId}`, label: 'l' }),
    webhookSubscriptions: (o) => ({ user: o.userId, url: 'https://hook.test', secret: 's3cret' }),
    webhookDeliveries: (o) => ({ user: o.userId, subscriptionId: 'sub', payload: {} }),
    oauthAuthCodes: (o) => ({ user: o.userId, clientId: 'c', codeChallenge: 'ch' }),
    oauthRefreshTokens: (o) => ({ user: o.userId, clientId: 'c', rotatedToId: 'next-hash' }),
    claudeUsage: (o) => ({ user: o.userId, day: '2026-01-01' }),
    briefBatchRequests: (o) => ({ user: o.userId, batchId: 'b', itemId: 'i' }),
    session: (o) => ({ userId: betterAuthId(o), token: `sess-${o.userId}` }),
    account: (o) => ({ userId: betterAuthId(o), providerId: 'google', accessToken: 'plain-at', refreshToken: 'plain-rt', idToken: 'id' }),
    user: (o) => ({ _id: betterAuthId(o), email: o.email, name: o.userId }),
};

/**
 * Seeds one row in EVERY user-scoped collection for `owner`. The calendar integration goes through
 * the DAO (tokens encrypted exactly like production rows) and the Better Auth account row carries
 * encrypted sign-in tokens, so the deletion's decrypt-then-revoke path is exercised for real.
 */
export async function seedUserAcrossCollections(owner: FixtureOwner): Promise<void> {
    const now = dayjs().toISOString();
    const plainRows = Object.entries(USER_DATA_FIXTURES).filter(([collection]) => collection !== 'calendarIntegrations' && collection !== 'account');
    await Promise.all(plainRows.map(([collection, fixture]) => db.collection(collection).insertOne(fixture(owner) as never)));
    await db.collection('account').insertOne({
        userId: betterAuthId(owner),
        providerId: 'google',
        accessToken: await encryptBetterAuthToken(`signin-at-${owner.userId}`),
        refreshToken: await encryptBetterAuthToken(`signin-rt-${owner.userId}`),
    } as never);
    await calendarIntegrationsDAO.insertEncrypted({
        _id: `int-${owner.userId}`,
        user: owner.userId,
        provider: 'google',
        accessToken: `cal-at-${owner.userId}`,
        refreshToken: `cal-rt-${owner.userId}`,
        tokenExpiry: now,
        createdTs: now,
        updatedTs: now,
    });
}
