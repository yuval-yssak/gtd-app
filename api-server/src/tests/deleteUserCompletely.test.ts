/**
 * `lib/deleteUserCompletely.ts` — the single implementation behind `DELETE /auth/me`, the admin
 * CLI and the dev endpoint. Pins: every user-scoped collection is emptied for the deleted user
 * and untouched for a second user; the deletion order's crash-safety (tombstone before the user
 * row, user row only after the tombstone); Google side effects are attempted, bounded, and their
 * failures never abort the deletion; re-running is idempotent; a dry run changes nothing and reports
 * accurate counts; live SSE channels receive `account-deleted` and are closed; a device shared with
 * another account keeps its push subscription.
 */
import dayjs from 'dayjs';
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleCalendarProvider } from '../calendarProviders/GoogleCalendarProvider.js';
import deletedUsersDAO from '../dataAccess/deletedUsersDAO.js';
import { withSyncLock } from '../lib/calendarSyncLock.js';
import { __setBestEffortStepTimeoutForTests, deleteUserCompletely } from '../lib/deleteUserCompletely.js';
import { addSseConnection, sseConnectionCountForUser } from '../lib/sseConnections.js';
import { inventoriedCollectionNames, USER_DATA_COLLECTIONS, USER_ROW_SPEC, type UserIdentity } from '../lib/userDataInventory.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { revokedTokensFrom, stubGoogleRevokeEndpoint } from './helpers.js';
import { type FixtureOwner, seedUserAcrossCollections } from './userDataFixtures.js';

const ALICE: FixtureOwner = { userId: new ObjectId().toHexString(), email: 'alice@delete.test', betterAuthIdAsObjectId: true };
const BOB: FixtureOwner = { userId: 'delete-bob', email: 'bob@delete.test' };

beforeAll(async () => {
    await loadDataAccess('gtd_test_delete_user');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([...inventoriedCollectionNames()].map((name) => db.collection(name).deleteMany({})));
    vi.restoreAllMocks();
});

async function countRowsFor(owner: UserIdentity): Promise<Record<string, number>> {
    const counts = await Promise.all(
        [...USER_DATA_COLLECTIONS, USER_ROW_SPEC].map(
            async (spec) => [spec.collection, await db.collection(spec.collection).countDocuments(spec.filter(owner))] as const,
        ),
    );
    return Object.fromEntries(counts);
}

function allZero(counts: Record<string, number>): boolean {
    return Object.values(counts).every((count) => count === 0);
}

function stubStopWatch() {
    return vi.spyOn(GoogleCalendarProvider.prototype, 'stopWatch').mockResolvedValue(undefined);
}

interface FakeController {
    sent: string[];
    closed: boolean;
}

function attachFakeSseChannel(userId: string): FakeController {
    const fake: FakeController = { sent: [], closed: false };
    const controller = {
        enqueue: (chunk: Uint8Array) => fake.sent.push(new TextDecoder().decode(chunk)),
        close: () => {
            fake.closed = true;
        },
    } as unknown as ReadableStreamDefaultController<Uint8Array>;
    addSseConnection(userId, controller);
    return fake;
}

describe('deleteUserCompletely', () => {
    it('erases every user-scoped row of the deleted user, leaves a second user intact, writes the tombstone and removes the user row', async () => {
        await Promise.all([seedUserAcrossCollections(ALICE), seedUserAcrossCollections(BOB)]);
        stubGoogleRevokeEndpoint();
        stubStopWatch();
        const bobBefore = await countRowsFor(BOB);
        expect(Object.values(bobBefore).every((count) => count === 1)).toBe(true);

        const report = await deleteUserCompletely(ALICE.userId);

        const aliceAfter = await countRowsFor(ALICE);
        expect(allZero(aliceAfter), JSON.stringify(aliceAfter)).toBe(true);
        expect(await countRowsFor(BOB)).toEqual(bobBefore);
        // Every collection reported exactly the one row that was seeded.
        for (const spec of [...USER_DATA_COLLECTIONS, USER_ROW_SPEC]) {
            expect(report.deleted[spec.collection], spec.collection).toBe(1);
        }
        const tombstone = await deletedUsersDAO.findByUserId(ALICE.userId);
        // No personal data on the tombstone — the privacy policy promises only the fact of deletion is kept.
        expect(tombstone).toEqual({ _id: ALICE.userId, deletedAt: expect.any(String) });
        expect(dayjs(tombstone?.deletedAt).isValid()).toBe(true);
        expect(report.tombstoneWritten).toBe(true);
        expect(report.email).toBe(ALICE.email);
        expect(await deletedUsersDAO.findByUserId(BOB.userId)).toBeNull();
    });

    it('stops each live webhook channel and revokes the calendar grant AND the Google sign-in grant', async () => {
        await seedUserAcrossCollections(ALICE);
        const fetchSpy = stubGoogleRevokeEndpoint();
        const stopWatch = stubStopWatch();

        const report = await deleteUserCompletely(ALICE.userId);

        expect(stopWatch).toHaveBeenCalledWith(`chan-${ALICE.userId}`, `res-${ALICE.userId}`);
        expect(report.webhookChannels).toEqual({ attempted: 1, succeeded: 1, failed: 0, skipped: 0 });
        // Refresh tokens win over access tokens, and the sign-in token was decrypted before revocation.
        expect(revokedTokensFrom(fetchSpy).sort()).toEqual([`cal-rt-${ALICE.userId}`, `signin-rt-${ALICE.userId}`]);
        expect(report.googleTokenRevocations).toEqual({ attempted: 2, succeeded: 2, failed: 0, skipped: 0 });
    });

    it('still deletes everything when the webhook stop fails and Google is unreachable for the revocation', async () => {
        await seedUserAcrossCollections(ALICE);
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));
        vi.spyOn(GoogleCalendarProvider.prototype, 'stopWatch').mockRejectedValue(new Error('channel expired'));

        const report = await deleteUserCompletely(ALICE.userId);

        expect(report.webhookChannels).toEqual({ attempted: 1, succeeded: 0, failed: 1, skipped: 0 });
        expect(report.googleTokenRevocations.failed).toBe(2);
        expect(allZero(await countRowsFor(ALICE))).toBe(true);
        expect(await deletedUsersDAO.findByUserId(ALICE.userId)).not.toBeNull();
    });

    it('counts a 400 from Google as a success — the shared grant was already killed by the first revocation', async () => {
        await seedUserAcrossCollections(ALICE);
        stubGoogleRevokeEndpoint(400);
        stubStopWatch();

        const report = await deleteUserCompletely(ALICE.userId);

        expect(report.googleTokenRevocations).toEqual({ attempted: 2, succeeded: 2, failed: 0, skipped: 0 });
    });

    it('does not wait on a hung webhook stop forever', async () => {
        await seedUserAcrossCollections(ALICE);
        stubGoogleRevokeEndpoint();
        // A real (shortened) timeout rather than fake timers — the Mongo driver's own timers must keep running.
        __setBestEffortStepTimeoutForTests(50);
        try {
            vi.spyOn(GoogleCalendarProvider.prototype, 'stopWatch').mockImplementation(() => new Promise(() => {}));
            const report = await deleteUserCompletely(ALICE.userId);
            expect(report.webhookChannels).toEqual({ attempted: 1, succeeded: 0, failed: 1, skipped: 0 });
        } finally {
            __setBestEffortStepTimeoutForTests();
        }
        expect(allZero(await countRowsFor(ALICE))).toBe(true);
    });

    it('skips (and reports as skipped) revocations for which no readable token exists, instead of counting them as successes', async () => {
        await seedUserAcrossCollections(ALICE);
        // Sign-in tokens written under a different BETTER_AUTH_SECRET decrypt to nothing.
        await db.collection('account').updateMany({}, { $set: { accessToken: '$ba$1$not-ours', refreshToken: '$ba$1$not-ours-either' } });
        const fetchSpy = stubGoogleRevokeEndpoint();
        stubStopWatch();

        const report = await deleteUserCompletely(ALICE.userId);

        expect(revokedTokensFrom(fetchSpy)).toEqual([`cal-rt-${ALICE.userId}`]);
        expect(report.googleTokenRevocations).toEqual({ attempted: 2, succeeded: 1, failed: 0, skipped: 1 });
    });

    it('an undecryptable calendar integration row forfeits its Google side effects but never blocks the deletion', async () => {
        await seedUserAcrossCollections(ALICE);
        await db.collection('calendarIntegrations').updateMany({ user: ALICE.userId }, { $set: { accessToken: 'garbage', refreshToken: 'garbage' } });
        const fetchSpy = stubGoogleRevokeEndpoint();
        const stopWatch = stubStopWatch();

        const report = await deleteUserCompletely(ALICE.userId);

        expect(stopWatch).not.toHaveBeenCalled();
        expect(report.webhookChannels.attempted).toBe(0);
        // The sign-in grant is still revoked; the undecryptable integration is counted as a failed revocation.
        expect(revokedTokensFrom(fetchSpy)).toEqual([`signin-rt-${ALICE.userId}`]);
        expect(report.googleTokenRevocations).toEqual({ attempted: 2, succeeded: 1, failed: 1, skipped: 0 });
        expect(allZero(await countRowsFor(ALICE))).toBe(true);
    });

    it('is idempotent — a second run deletes nothing and keeps the FIRST run’s tombstone', async () => {
        await seedUserAcrossCollections(ALICE);
        stubGoogleRevokeEndpoint();
        stubStopWatch();
        await deleteUserCompletely(ALICE.userId);
        const firstTombstone = await deletedUsersDAO.findByUserId(ALICE.userId);
        expect(firstTombstone).not.toBeNull();

        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(dayjs().add(1, 'hour').toDate());
            const second = await deleteUserCompletely(ALICE.userId);
            expect(allZero(second.deleted)).toBe(true);
            expect(second.googleTokenRevocations.attempted).toBe(0);
            // The user row is gone, so the email can no longer be resolved.
            expect(second.email).toBeNull();
            expect(second.tombstoneWritten).toBe(true);
        } finally {
            vi.useRealTimers();
        }
        // `deletedAt` records when the account actually went — not when someone re-ran the deletion.
        expect(await deletedUsersDAO.findByUserId(ALICE.userId)).toEqual(firstTombstone);
    });

    it('dryRun reports the would-delete counts and side-effect candidates without changing or calling anything', async () => {
        await seedUserAcrossCollections(ALICE);
        const fetchSpy = stubGoogleRevokeEndpoint();
        const stopWatch = stubStopWatch();
        const before = await countRowsFor(ALICE);

        const report = await deleteUserCompletely(ALICE.userId, { dryRun: true });

        expect(report.dryRun).toBe(true);
        expect(report.deleted).toEqual(before);
        expect(report.webhookChannels.attempted).toBe(1);
        expect(report.googleTokenRevocations.attempted).toBe(2);
        expect(report.tombstoneWritten).toBe(false);
        expect(await countRowsFor(ALICE)).toEqual(before);
        expect(await deletedUsersDAO.findByUserId(ALICE.userId)).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(stopWatch).not.toHaveBeenCalled();
    });

    it('broadcasts account-deleted to the user’s live SSE channels, closes them and leaves other users’ channels open', async () => {
        await Promise.all([seedUserAcrossCollections(ALICE), seedUserAcrossCollections(BOB)]);
        stubGoogleRevokeEndpoint();
        stubStopWatch();
        const aliceTab = attachFakeSseChannel(ALICE.userId);
        const bobTab = attachFakeSseChannel(BOB.userId);

        const report = await deleteUserCompletely(ALICE.userId);

        expect(report.sseConnectionsClosed).toBe(1);
        expect(aliceTab.sent.join('')).toContain(JSON.stringify({ type: 'account-deleted', userId: ALICE.userId }));
        expect(aliceTab.closed).toBe(true);
        expect(sseConnectionCountForUser(ALICE.userId)).toBe(0);
        expect(bobTab.sent).toEqual([]);
        expect(bobTab.closed).toBe(false);
        expect(sseConnectionCountForUser(BOB.userId)).toBe(1);
    });
});

describe('deleteUserCompletely — ordering against in-flight work', () => {
    it('cuts access (sessions, API tokens, OAuth grants) BEFORE the Google side effects and the data deletes', async () => {
        await seedUserAcrossCollections(ALICE);
        stubGoogleRevokeEndpoint();
        const seenDuringStopWatch: Record<string, number> = {};
        vi.spyOn(GoogleCalendarProvider.prototype, 'stopWatch').mockImplementation(async () => {
            for (const collection of ['session', 'apiTokens', 'oauthRefreshTokens', 'oauthAuthCodes', 'items']) {
                const spec = [...USER_DATA_COLLECTIONS].find((candidate) => candidate.collection === collection);
                if (!spec) {
                    throw new Error(`spec ${collection} missing`);
                }
                seenDuringStopWatch[collection] = await db.collection(collection).countDocuments(spec.filter(ALICE));
            }
        });

        await deleteUserCompletely(ALICE.userId);

        expect(seenDuringStopWatch).toEqual({ session: 0, apiTokens: 0, oauthRefreshTokens: 0, oauthAuthCodes: 0, items: 1 });
    });

    it('waits for an in-flight calendar sync of the user before erasing rows', async () => {
        await seedUserAcrossCollections(ALICE);
        stubGoogleRevokeEndpoint();
        stubStopWatch();
        const config = await db.collection('calendarSyncConfigs').findOne({ user: ALICE.userId });
        if (!config) {
            throw new Error('expected a sync config');
        }
        const now = dayjs().toISOString();
        // A sync that is still running when the deletion starts and writes an item just before it ends.
        // It also records whether the tombstone already existed when it wrote: had the deletion NOT
        // waited for the lock, the row deletes (and the tombstone) could have run first.
        let tombstoneSeenBySync: unknown = 'not-checked';
        const inFlightSync = withSyncLock(config as never, async () => {
            await new Promise((resolve) => setTimeout(resolve, 150));
            tombstoneSeenBySync = await deletedUsersDAO.findByUserId(ALICE.userId);
            await db
                .collection('items')
                .insertOne({ _id: 'written-by-sync', user: ALICE.userId, status: 'inbox', title: 's', createdTs: now, updatedTs: now } as never);
        });

        const report = await deleteUserCompletely(ALICE.userId);
        await inFlightSync;

        // The sync finished BEFORE the deletion erased anything (no tombstone yet), and both the seeded
        // item and the one the sync wrote are gone.
        expect(tombstoneSeenBySync).toBeNull();
        expect(report.deleted.items).toBe(2);
        expect(await db.collection('items').countDocuments({ user: ALICE.userId })).toBe(0);
    });

    it('gives up waiting on a sync that never finishes and still completes the deletion', async () => {
        await seedUserAcrossCollections(ALICE);
        stubGoogleRevokeEndpoint();
        stubStopWatch();
        const config = await db.collection('calendarSyncConfigs').findOne({ user: ALICE.userId });
        if (!config) {
            throw new Error('expected a sync config');
        }
        let releaseLock: () => void = () => undefined;
        const heldForever = withSyncLock(
            config as never,
            () =>
                new Promise<void>((resolve) => {
                    releaseLock = resolve;
                }),
        );
        __setBestEffortStepTimeoutForTests(50);
        try {
            const report = await deleteUserCompletely(ALICE.userId);
            expect(report.tombstoneWritten).toBe(true);
            expect(allZero(await countRowsFor(ALICE))).toBe(true);
        } finally {
            __setBestEffortStepTimeoutForTests();
            releaseLock();
            await heldForever;
        }
    });
});

describe('deleteUserCompletely — Google grants shared with another user', () => {
    it('leaves the calendar grant alone when another GTD user connected the same Google account, and still revokes the rest', async () => {
        await Promise.all([seedUserAcrossCollections(ALICE), seedUserAcrossCollections(BOB)]);
        // Alice's and Bob's integrations are the same Google account (e.g. a shared team calendar login).
        await db.collection('calendarIntegrations').updateMany({ user: { $in: [ALICE.userId, BOB.userId] } }, { $set: { accountEmail: 'shared@gmail.com' } });
        const fetchSpy = stubGoogleRevokeEndpoint();
        stubStopWatch();

        const report = await deleteUserCompletely(ALICE.userId);

        // Only Alice's own sign-in grant (her email, used by nobody else) is revoked.
        expect(revokedTokensFrom(fetchSpy)).toEqual([`signin-rt-${ALICE.userId}`]);
        expect(report.googleTokenRevocations).toEqual({ attempted: 2, succeeded: 1, failed: 0, skipped: 1 });
        // Bob's integration still has its tokens.
        expect(await db.collection('calendarIntegrations').countDocuments({ user: BOB.userId })).toBe(1);
    });

    it('also spares the sign-in grant when another user connected a calendar on the deleted user’s Google account', async () => {
        await Promise.all([seedUserAcrossCollections(ALICE), seedUserAcrossCollections(BOB)]);
        await db.collection('calendarIntegrations').updateOne({ user: BOB.userId }, { $set: { accountEmail: ALICE.email } });
        const fetchSpy = stubGoogleRevokeEndpoint();
        stubStopWatch();

        const report = await deleteUserCompletely(ALICE.userId);

        expect(revokedTokensFrom(fetchSpy)).toEqual([`cal-rt-${ALICE.userId}`]);
        expect(report.googleTokenRevocations).toEqual({ attempted: 2, succeeded: 1, failed: 0, skipped: 1 });
    });
});

describe('deleteUserCompletely — crash-safety order', () => {
    it('a failing tombstone write leaves the user row in place (recoverable by re-running) and rejects', async () => {
        await seedUserAcrossCollections(ALICE);
        stubGoogleRevokeEndpoint();
        stubStopWatch();
        vi.spyOn(deletedUsersDAO, 'upsertTombstone').mockRejectedValueOnce(new Error('mongo down'));

        await expect(deleteUserCompletely(ALICE.userId)).rejects.toThrow('mongo down');

        expect(await db.collection('user').countDocuments(USER_ROW_SPEC.filter(ALICE))).toBe(1);
        expect(await deletedUsersDAO.findByUserId(ALICE.userId)).toBeNull();
    });

    it('a failing data delete leaves no tombstone and keeps the user row', async () => {
        await seedUserAcrossCollections(ALICE);
        stubGoogleRevokeEndpoint();
        stubStopWatch();
        const realCollection = db.collection.bind(db);
        // Only `items.deleteMany` fails; every other collection call is the real one.
        vi.spyOn(db, 'collection').mockImplementation(((name: string) => {
            const collection = realCollection(name);
            if (name !== 'items') {
                return collection;
            }
            return new Proxy(collection, {
                get: (target, property) =>
                    property === 'deleteMany' ? async () => Promise.reject(new Error('items delete failed')) : Reflect.get(target, property),
            });
        }) as never);
        try {
            await expect(deleteUserCompletely(ALICE.userId)).rejects.toThrow('items delete failed');
        } finally {
            vi.mocked(db.collection).mockRestore();
        }
        expect(await db.collection('user').countDocuments(USER_ROW_SPEC.filter(ALICE))).toBe(1);
        expect(await deletedUsersDAO.findByUserId(ALICE.userId)).toBeNull();
    });

    it('sweeps rows a writer that was already past authentication landed between the first pass and the user-row delete', async () => {
        await seedUserAcrossCollections(ALICE);
        stubGoogleRevokeEndpoint();
        stubStopWatch();
        const now = dayjs().toISOString();
        const realUpsert = deletedUsersDAO.upsertTombstone.bind(deletedUsersDAO);
        vi.spyOn(deletedUsersDAO, 'upsertTombstone').mockImplementationOnce(async (tombstone) => {
            // Simulates e.g. a /sync/push that authenticated a moment before the sessions were cut.
            await db
                .collection('items')
                .insertOne({ _id: 'late-item', user: ALICE.userId, status: 'inbox', title: 'late', createdTs: now, updatedTs: now } as never);
            await realUpsert(tombstone);
        });

        const report = await deleteUserCompletely(ALICE.userId);

        expect(report.deleted.items).toBe(2);
        expect(await db.collection('items').countDocuments({ user: ALICE.userId })).toBe(0);
    });
});

describe('deleteUserCompletely — push subscriptions on a shared device', () => {
    it('hands the device’s subscription to the remaining account instead of deleting it; a device hosting nobody else loses it', async () => {
        await Promise.all([seedUserAcrossCollections(ALICE), seedUserAcrossCollections(BOB)]);
        // Alice's second device is shared with Bob: one subscription row, two deviceUsers rows.
        await db.collection('deviceUsers').insertMany([
            { _id: 'shared:alice', deviceId: 'shared', userId: ALICE.userId },
            { _id: 'shared:bob', deviceId: 'shared', userId: BOB.userId },
        ] as never);
        await db
            .collection('pushSubscriptions')
            .insertOne({ _id: 'shared', user: ALICE.userId, endpoint: 'https://push.test/shared', keys: { p256dh: 'k', auth: 'a' } } as never);
        stubGoogleRevokeEndpoint();
        stubStopWatch();

        const report = await deleteUserCompletely(ALICE.userId);

        // Alice's own device: nobody left → gone. The shared device: kept, now Bob's.
        expect(await db.collection('pushSubscriptions').findOne({ _id: `dev-${ALICE.userId}` } as never)).toBeNull();
        expect(await db.collection('pushSubscriptions').findOne({ _id: 'shared' } as never)).toMatchObject({
            user: BOB.userId,
            endpoint: 'https://push.test/shared',
        });
        expect(report.deleted.pushSubscriptions).toBe(1);
        expect(await db.collection('deviceUsers').countDocuments({ deviceId: 'shared' })).toBe(1);
        expect(await db.collection('pushSubscriptions').countDocuments({ user: ALICE.userId })).toBe(0);
    });

    it('dryRun counts only the subscriptions that would actually be deleted, not the ones that would be handed over', async () => {
        await Promise.all([seedUserAcrossCollections(ALICE), seedUserAcrossCollections(BOB)]);
        await db.collection('deviceUsers').insertMany([
            { _id: 'shared:alice', deviceId: 'shared', userId: ALICE.userId },
            { _id: 'shared:bob', deviceId: 'shared', userId: BOB.userId },
        ] as never);
        await db
            .collection('pushSubscriptions')
            .insertOne({ _id: 'shared', user: ALICE.userId, endpoint: 'https://push.test/shared', keys: { p256dh: 'k', auth: 'a' } } as never);

        const report = await deleteUserCompletely(ALICE.userId, { dryRun: true });

        expect(report.deleted.pushSubscriptions).toBe(1);
        expect(await db.collection('pushSubscriptions').countDocuments({ user: ALICE.userId })).toBe(2);
    });
});
