/**
 * One-off migration: encrypt the Google/GitHub sign-in tokens (`accessToken`, `refreshToken`) Better
 * Auth stored in plaintext on `account` rows before `account.encryptOAuthTokens` was switched on
 * (`auth/betterAuth.ts`).
 *
 * Better Auth reads mixed rows (plaintext values pass through its decrypt untouched), so this is
 * hygiene rather than a prerequisite: without it, pre-flag rows stay plaintext until that user
 * signs in again. Idempotent — already-encrypted values are recognised and skipped.
 *
 * Usage:
 *   cd api-server
 *   npx tsx --env-file=.env src/scripts/encryptBetterAuthTokens.ts [--dry-run]
 */

import type { AnyBulkWriteOperation, Db } from 'mongodb';
import { encryptBetterAuthToken, isLikelyEncryptedToken } from '../lib/betterAuthTokenCrypto.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';

/**
 * Exactly the fields Better Auth 1.5.6 itself runs through `setTokenUtil` (`api/routes/callback.mjs`,
 * `oauth2/link-account.mjs`). `idToken` is deliberately NOT here: the library stores it in plaintext
 * and never decrypts it, so encrypting it would hand ciphertext to any library path that reads it.
 */
export const ENCRYPTED_ACCOUNT_TOKEN_FIELDS = ['accessToken', 'refreshToken'] as const;
type TokenField = (typeof ENCRYPTED_ACCOUNT_TOKEN_FIELDS)[number];

type AccountRow = { _id: unknown } & Partial<Record<TokenField, string | null>>;

export interface EncryptionSummary {
    rowsScanned: number;
    rowsUpdated: number;
    fieldsEncrypted: number;
}

function plaintextFields(row: AccountRow): TokenField[] {
    return ENCRYPTED_ACCOUNT_TOKEN_FIELDS.filter((field) => {
        const value = row[field];
        return typeof value === 'string' && value !== '' && !isLikelyEncryptedToken(value);
    });
}

async function encryptedPatch(row: AccountRow, fields: TokenField[]): Promise<Record<string, string>> {
    const entries = await Promise.all(fields.map(async (field) => [field, await encryptBetterAuthToken(row[field] ?? '')] as const));
    return Object.fromEntries(entries);
}

/**
 * Matches the row only while it still holds the plaintext values the patch was computed from: a
 * sign-in between the read and the write would otherwise have its fresh token replaced by the
 * encrypted stale one. A row that moved on is simply not updated (and is already encrypted by the
 * library, since the flag is on).
 */
async function encryptRowOperation(row: AccountRow, fields: TokenField[]): Promise<AnyBulkWriteOperation<AccountRow>> {
    const unchangedFilter = Object.fromEntries(fields.map((field) => [field, row[field]]));
    return { updateOne: { filter: { _id: row._id, ...unchangedFilter } as never, update: { $set: await encryptedPatch(row, fields) } } };
}

export async function encryptPlaintextAccountTokens(database: Db, options: { dryRun: boolean }): Promise<EncryptionSummary> {
    const rows = await database.collection<AccountRow>('account').find({}).toArray();
    const pending = rows.map((row) => ({ row, fields: plaintextFields(row) })).filter(({ fields }) => fields.length > 0);
    const operations = await Promise.all(pending.map(({ row, fields }) => encryptRowOperation(row, fields)));
    const rowsUpdated =
        options.dryRun || operations.length === 0 ? pending.length : (await database.collection<AccountRow>('account').bulkWrite(operations)).modifiedCount;
    return {
        rowsScanned: rows.length,
        rowsUpdated,
        fieldsEncrypted: pending.reduce((sum, { fields }) => sum + fields.length, 0),
    };
}

async function run(): Promise<void> {
    const dryRun = process.argv.includes('--dry-run');
    await loadDataAccess();
    try {
        const summary = await encryptPlaintextAccountTokens(db, { dryRun });
        console.log(
            `${dryRun ? '[dry-run] would encrypt' : 'Encrypted'} ${summary.fieldsEncrypted} token field(s) on ${summary.rowsUpdated} of ${summary.rowsScanned} account row(s).`,
        );
    } finally {
        await closeDataAccess();
    }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    run().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
