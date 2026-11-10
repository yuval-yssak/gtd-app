import type { Dayjs } from 'dayjs';
import { type Collection, type Db, type Document, MongoServerError } from 'mongodb';

/**
 * An expiry stored twice: `expiresTs` (ISO string) is what queries compare against, the same way
 * every other timestamp in the schema is compared; `expiresAt` (BSON Date) exists only for the TTL
 * index, because MongoDB TTL indexes silently skip documents whose field is not a Date.
 */
export function expiryFields(expiresAt: Dayjs) {
    return { expiresTs: expiresAt.toISOString(), expiresAt: expiresAt.toDate() };
}

/** The pre-fix index: a TTL on the string `expiresTs`, which never reaped anything. */
const LEGACY_STRING_TTL_INDEX = 'expiresTs_1';

const INDEX_NOT_FOUND = 27;

function isIndexNotFound(err: unknown) {
    return err instanceof MongoServerError && err.code === INDEX_NOT_FOUND;
}

/** Drop-and-tolerate rather than check-then-drop: a CLI booting alongside the server may win the drop. */
async function dropLegacyStringTtl(collection: Collection<Document>) {
    await collection.dropIndex(LEGACY_STRING_TTL_INDEX).catch((err: unknown) => {
        if (!isIndexNotFound(err)) {
            throw err;
        }
    });
}

/**
 * Rows written before `expiresAt` existed: derive it from their `expiresTs` so the TTL index can reap them.
 * An unparseable `expiresTs` leaves the row as it was (`$$REMOVE`) — `$toDate` would throw and fail boot.
 */
async function backfillExpiresAt(collection: Collection<Document>) {
    await collection.updateMany({ expiresTs: { $type: 'string' }, expiresAt: { $exists: false } }, [
        { $set: { expiresAt: { $convert: { input: '$expiresTs', to: 'date', onError: '$$REMOVE' } } } },
    ]);
}

/**
 * Makes the collection self-cleaning on `expiresAt`. Idempotent — runs on every boot from the DAO's
 * `init`. Partial so rows that never expire (personal API tokens) are never touched.
 */
export async function ensureExpiresAtTtl(db: Db, collectionName: string) {
    // Untyped on purpose: these maintenance writes touch only the expiry fields every caller shares.
    const collection = db.collection(collectionName);
    await dropLegacyStringTtl(collection);
    await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, partialFilterExpression: { expiresAt: { $exists: true } } });
    await backfillExpiresAt(collection);
}
