/**
 * The inventory in `lib/userDataInventory.ts` is what account deletion erases and what the data
 * export returns. Two guarantees are pinned here:
 *   1. Completeness — every DAO under `src/dataAccess/` and every Better Auth collection is either
 *      user-scoped and listed, or explicitly declared not user-scoped. A new collection fails this
 *      file until its owner has decided both the deletion and the export policy.
 *   2. Correctness of each owner filter — a row seeded under the user's real owner field (from the
 *      independently written `tests/userDataFixtures.ts`) matches and a row owned by someone else does
 *      not (catches `user` vs `userId` mix-ups), for both the string and the ObjectId shapes Better
 *      Auth ids take.
 */
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Document, ObjectId } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    applyExportPolicy,
    betterAuthIdFilter,
    inventoriedCollectionNames,
    NOT_USER_SCOPED_COLLECTIONS,
    USER_DATA_COLLECTIONS,
    USER_ROW_SPEC,
    type UserCollectionSpec,
    type UserIdentity,
} from '../lib/userDataInventory.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import { USER_DATA_FIXTURES } from './userDataFixtures.js';

/** Better Auth owns these; there is no DAO to enumerate, so they are listed by hand. */
const BETTER_AUTH_COLLECTIONS = ['user', 'session', 'account', 'verification'];

const ALICE: UserIdentity = { userId: 'inventory-alice', email: 'alice@inventory.test' };
const BOB: UserIdentity = { userId: 'inventory-bob', email: 'bob@inventory.test' };

function daoCollectionNames(): Promise<string[]> {
    const daoDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dataAccess');
    const files = readdirSync(daoDir).filter((file) => file.endsWith('DAO.ts') && file !== 'abstractDAO.ts');
    return Promise.all(
        files.map(async (file) => {
            const module = (await import(new URL(`../dataAccess/${file}`, import.meta.url).href)) as { default: { COLLECTION_NAME: string } };
            return module.default.COLLECTION_NAME;
        }),
    );
}

function specFor(name: string): UserCollectionSpec {
    const spec = USER_DATA_COLLECTIONS.find((candidate) => candidate.collection === name);
    if (!spec) {
        throw new Error(`spec ${name} missing`);
    }
    return spec;
}

function fixtureFor(collection: string): (owner: UserIdentity) => Document {
    const fixture = USER_DATA_FIXTURES[collection];
    if (!fixture) {
        throw new Error(`no test fixture for collection ${collection} — add it to tests/userDataFixtures.ts`);
    }
    return fixture;
}

async function seedBoth(spec: UserCollectionSpec): Promise<void> {
    const fixture = fixtureFor(spec.collection);
    await db.collection(spec.collection).insertMany([fixture(ALICE), fixture(BOB)]);
}

beforeAll(async () => {
    await loadDataAccess('gtd_test_inventory');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([...inventoriedCollectionNames()].map((name) => db.collection(name).deleteMany({})));
});

describe('inventory completeness', () => {
    it('covers every DAO collection and every Better Auth collection, or declares it not user-scoped', async () => {
        const known = inventoriedCollectionNames();
        const missing = [...(await daoCollectionNames()), ...BETTER_AUTH_COLLECTIONS].filter((name) => !known.has(name));
        expect(missing, 'add each of these to USER_DATA_COLLECTIONS (with an export policy) or NOT_USER_SCOPED_COLLECTIONS (with a reason)').toEqual([]);
    });

    it('lists no collection twice and gives every non-user-scoped collection a reason', () => {
        const names = [...USER_DATA_COLLECTIONS.map((spec) => spec.collection), USER_ROW_SPEC.collection, ...NOT_USER_SCOPED_COLLECTIONS.keys()];
        expect(new Set(names).size).toBe(names.length);
        for (const reason of NOT_USER_SCOPED_COLLECTIONS.values()) {
            expect(reason.length).toBeGreaterThan(10);
        }
    });

    it('has a test fixture for every user-scoped collection', () => {
        const withoutFixture = [...USER_DATA_COLLECTIONS, USER_ROW_SPEC].map((spec) => spec.collection).filter((name) => !USER_DATA_FIXTURES[name]);
        expect(withoutFixture).toEqual([]);
    });
});

describe('owner filters', () => {
    it.each(
        [...USER_DATA_COLLECTIONS, USER_ROW_SPEC].map((spec) => [spec.collection, spec] as const),
    )('%s matches exactly the owner’s rows', async (_name, spec) => {
        await seedBoth(spec);
        const matched = await db.collection(spec.collection).find(spec.filter(ALICE)).toArray();
        expect(matched).toHaveLength(1);
        const [row] = matched;
        if (!row) {
            throw new Error('expected one matched row');
        }
        // Whatever the owner field is, the matched row is Alice's and never Bob's.
        expect(JSON.stringify(row)).toContain(ALICE.userId);
        expect(JSON.stringify(row)).not.toContain(BOB.userId);
    });

    it('matches Better Auth rows whose ids are stored as ObjectId', async () => {
        const oid = new ObjectId();
        const owner: UserIdentity = { userId: oid.toHexString(), email: 'oid@inventory.test' };
        await db.collection('user').insertOne({ _id: oid, email: owner.email } as never);
        await db.collection('session').insertOne({ userId: oid, token: 't' } as never);
        await db.collection('account').insertOne({ userId: oid, providerId: 'google' } as never);
        const [users, sessions, accounts] = await Promise.all([
            db.collection('user').countDocuments(USER_ROW_SPEC.filter(owner)),
            db.collection('session').countDocuments(specFor('session').filter(owner)),
            db.collection('account').countDocuments(specFor('account').filter(owner)),
        ]);
        expect([users, sessions, accounts]).toEqual([1, 1, 1]);
    });

    it('betterAuthIdFilter offers both shapes only for ObjectId-looking ids', () => {
        expect(betterAuthIdFilter('plain-string-id').$in).toEqual(['plain-string-id']);
        const hex = new ObjectId().toHexString();
        const { $in } = betterAuthIdFilter(hex);
        expect($in).toHaveLength(2);
        expect($in[0]).toBe(hex);
        expect($in[1]).toBeInstanceOf(ObjectId);
    });
});

describe('export policies', () => {
    it('strips credentials from the redacted collections', () => {
        const cases: Array<[string, string[]]> = [
            ['calendarIntegrations', ['accessToken', 'refreshToken']],
            ['pushSubscriptions', ['endpoint', 'keys']],
            ['apiTokens', ['tokenHash']],
            ['webhookSubscriptions', ['secret']],
            ['account', ['accessToken', 'refreshToken', 'idToken']],
            ['session', ['token']],
            ['oauthRefreshTokens', ['_id', 'rotatedToId']],
            ['oauthAuthCodes', ['_id', 'codeChallenge']],
            ['calendarSyncConfigs', ['syncToken']],
        ];
        for (const [name, secretFields] of cases) {
            const spec = specFor(name);
            const exported = applyExportPolicy(spec, [{ _id: 'row', ...fixtureFor(name)(ALICE) }]);
            expect(exported, name).not.toBeNull();
            for (const field of secretFields) {
                expect(exported?.[0], `${name}.${field} must not be exported`).not.toHaveProperty(field);
            }
            // Redaction removes fields; it never drops the row.
            expect(exported).toHaveLength(1);
        }
    });

    it('omits the operations log', () => {
        expect(applyExportPolicy(specFor('operations'), [{ _id: 'op' }])).toBeNull();
    });

    it('exports full rows untouched', () => {
        const row = { _id: 'i1', user: ALICE.userId, title: 'keep me' };
        expect(applyExportPolicy(specFor('items'), [row])).toEqual([row]);
    });
});
