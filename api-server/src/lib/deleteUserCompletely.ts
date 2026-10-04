import dayjs from 'dayjs';
import type { Document } from 'mongodb';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import deletedUsersDAO from '../dataAccess/deletedUsersDAO.js';
import deviceUsersDAO from '../dataAccess/deviceUsersDAO.js';
import pushSubscriptionsDAO from '../dataAccess/pushSubscriptionsDAO.js';
import { db } from '../loaders/mainLoader.js';
import type { CalendarIntegrationInterface, CalendarSyncConfigInterface } from '../types/entities.js';
import { readBetterAuthToken } from './betterAuthTokenCrypto.js';
import { buildCalendarProvider } from './buildCalendarProvider.js';
import { drainCalendarSyncLocks } from './calendarSyncLock.js';
import { type GoogleTokenRevokeOutcome, revokeGoogleGrant } from './googleTokenRevoke.js';
import { broadcastAccountDeletedAndClose } from './sseConnections.js';
import { decrypt } from './tokenEncryption.js';
import { USER_DATA_COLLECTIONS, USER_ROW_SPEC, type UserCollectionSpec, type UserIdentity } from './userDataInventory.js';
import { findUserById } from './userLookup.js';
import { withTimeout } from './withTimeout.js';

/**
 * Hard-deletes a user and everything they own, then leaves a permanent tombstone. The single
 * implementation behind the self-service `DELETE /auth/me`, the admin CLI (`scripts/deleteUser.ts`)
 * and the dev endpoint the e2e suite drives.
 *
 * Order matters:
 *   1. Read what the Google side effects need (decrypted integration + sign-in tokens).
 *   2. Cut access: sessions, API tokens and OAuth grants go first, so no new request can authenticate
 *      as this user while the rest runs.
 *   3. Google side effects (stop webhook channels, revoke the grants). Best-effort and bounded: a
 *      channel may already be expired, Google may be down, a row may be undecryptable. A grant that
 *      another GTD user also relies on (same Google account connected elsewhere) is left alone.
 *   4. Wait (bounded) for any calendar sync already in flight — after the revocation, so a sync that
 *      starts later fails at Google instead of writing rows for a deleted user.
 *   5. Every user-scoped collection from `userDataInventory.ts` — hard deletes, in parallel.
 *   6. The tombstone, THEN the Better Auth `user` row. A crash between the two leaves a user row
 *      with no data (recoverable by re-running), never a vanished user without a tombstone.
 *   7. A second sweep of step 5 for rows a writer that was already past auth landed in the gap.
 *   8. SSE `account-deleted` to the user's live tabs, which then evaporate the account locally.
 *
 * Steps 4 and 8 are in-process (the sync lock table and the SSE registry live in this server), so
 * the admin CLI — a separate process — skips them in effect; see `scripts/deleteUser.ts`.
 *
 * Idempotent: re-running on an already-deleted id keeps the first tombstone and deletes nothing.
 * `dryRun` reports the per-collection counts and makes no change at all (no Google calls either).
 */

export interface AttemptTally {
    attempted: number;
    succeeded: number;
    failed: number;
    /** Nothing to do (no token held, a token unreadable under the current secret, or a grant another user still needs). */
    skipped: number;
}

export interface DeletionReport {
    userId: string;
    email: string | null;
    dryRun: boolean;
    webhookChannels: AttemptTally;
    googleTokenRevocations: AttemptTally;
    /** Collection → rows deleted (or, in a dry run, rows that would be deleted). */
    deleted: Record<string, number>;
    tombstoneWritten: boolean;
    sseConnectionsClosed: number;
}

export interface DeleteUserOptions {
    dryRun?: boolean;
}

type Outcome = 'ok' | 'failed' | 'skipped';

/**
 * How long a single Google call, or the wait for in-flight syncs, may hold the deletion; matches the
 * revoke helper's own timeout. Best-effort steps must never pin a `DELETE /auth/me` to Cloud Run's
 * 300 s limit with the user already logged out and no tombstone written.
 */
const BEST_EFFORT_STEP_TIMEOUT_MS = 5_000;
let bestEffortStepTimeoutMs = BEST_EFFORT_STEP_TIMEOUT_MS;
/** Test-only: shrink the best-effort timeouts so hung-socket / held-lock tests do not wait the real 5 s. */
export function __setBestEffortStepTimeoutForTests(ms = BEST_EFFORT_STEP_TIMEOUT_MS): void {
    bestEffortStepTimeoutMs = ms;
}

/** Access-bearing collections, erased before anything else so in-flight callers lose authentication first. */
const ACCESS_COLLECTIONS = new Set(['session', 'apiTokens', 'oauthRefreshTokens', 'oauthAuthCodes']);

const emptyTally = (): AttemptTally => ({ attempted: 0, succeeded: 0, failed: 0, skipped: 0 });

function tally(outcomes: Outcome[]): AttemptTally {
    return {
        attempted: outcomes.length,
        succeeded: outcomes.filter((outcome) => outcome === 'ok').length,
        failed: outcomes.filter((outcome) => outcome === 'failed').length,
        skipped: outcomes.filter((outcome) => outcome === 'skipped').length,
    };
}

function sumCounts(first: Record<string, number>, second: Record<string, number>): Record<string, number> {
    return Object.fromEntries(Object.keys({ ...first, ...second }).map((collection) => [collection, (first[collection] ?? 0) + (second[collection] ?? 0)]));
}

export async function deleteUserCompletely(userId: string, options: DeleteUserOptions = {}): Promise<DeletionReport> {
    const owner = await resolveOwner(userId);
    const integrations = await readIntegrations(userId);
    if (options.dryRun) {
        return buildDryRunReport(owner, integrations);
    }
    const signInTokens = await readGoogleSignInTokens(owner);
    const accessDeleted = await deleteOwnedRows(owner, (spec) => ACCESS_COLLECTIONS.has(spec.collection));
    const webhookChannels = await stopWebhookChannels(userId, integrations);
    const googleTokenRevocations = await revokeGoogleGrants(owner, integrations, signInTokens);
    await drainInFlightSyncs(integrations.configs);
    const deleted = await eraseAndTombstone(owner);
    const sseConnectionsClosed = broadcastAccountDeletedAndClose(userId);
    const report = {
        userId,
        email: owner.email,
        dryRun: false,
        webhookChannels,
        googleTokenRevocations,
        deleted: sumCounts(accessDeleted, deleted),
        tombstoneWritten: true,
        sseConnectionsClosed,
    };
    console.log(`[delete-user] completed | userId=${userId} deleted=${JSON.stringify(report.deleted)} sseClosed=${sseConnectionsClosed}`);
    return report;
}

async function resolveOwner(userId: string): Promise<UserIdentity> {
    const user = await findUserById(userId);
    return { userId, email: user?.email?.toLowerCase() ?? null };
}

/** Steps 5–7: data rows, tombstone, user row, then the sweep for rows written into the gap. */
async function eraseAndTombstone(owner: UserIdentity): Promise<Record<string, number>> {
    const firstPass = await deleteOwnedRows(owner, (spec) => !ACCESS_COLLECTIONS.has(spec.collection));
    await deletedUsersDAO.upsertTombstone({ _id: owner.userId, deletedAt: dayjs().toISOString() });
    const userRow = { [USER_ROW_SPEC.collection]: await deleteRows(USER_ROW_SPEC.collection, USER_ROW_SPEC.filter(owner)) };
    const sweep = await deleteOwnedRows(owner, () => true);
    return sumCounts(sumCounts(firstPass, userRow), sweep);
}

/** Bounded wait for syncs already running for this user's calendars; the final sweep covers anything that outlives it. */
async function drainInFlightSyncs(configs: CalendarSyncConfigInterface[]): Promise<void> {
    try {
        await withTimeout(drainCalendarSyncLocks(configs), bestEffortStepTimeoutMs, 'drain in-flight calendar syncs');
    } catch (err) {
        console.warn('[delete-user] gave up waiting for in-flight calendar syncs', err);
    }
}

// ── Google side effects ───────────────────────────────────────────────────────

interface IntegrationsForDeletion {
    /** Integrations whose tokens decrypted; the ones that did not are counted in `undecryptable`. */
    decrypted: CalendarIntegrationInterface[];
    undecryptable: number;
    configs: CalendarSyncConfigInterface[];
}

/**
 * Reads the user's integrations, decrypting each row on its own: a row written under a rotated
 * `CALENDAR_ENCRYPTION_KEY` (or otherwise corrupt) must not make the whole deletion throw — it
 * just forfeits its webhook stop / revocation, which are best-effort anyway.
 */
async function readIntegrations(userId: string): Promise<IntegrationsForDeletion> {
    const rows = await calendarIntegrationsDAO.findArray({ user: userId });
    const decrypted = rows.flatMap((row) => {
        try {
            return [{ ...row, accessToken: decrypt(row.accessToken), refreshToken: decrypt(row.refreshToken) }];
        } catch (err) {
            console.warn(`[delete-user] integration ${row._id} is undecryptable — skipping its Google side effects`, err);
            return [];
        }
    });
    const configs = (await Promise.all(rows.map((row) => calendarSyncConfigsDAO.findByIntegration(row._id)))).flat();
    return { decrypted, undecryptable: rows.length - decrypted.length, configs };
}

function liveChannels(configs: CalendarSyncConfigInterface[], integrationId: string): CalendarSyncConfigInterface[] {
    return configs.filter((config) => config.integrationId === integrationId && config.webhookChannelId && config.webhookResourceId);
}

/** Stops every live Google push channel so Google stops notifying a webhook URL for data that no longer exists. */
async function stopWebhookChannels(userId: string, integrations: IntegrationsForDeletion): Promise<AttemptTally> {
    const outcomes = await Promise.all(
        integrations.decrypted.flatMap((integration) => {
            const provider = buildCalendarProvider(integration, userId);
            return liveChannels(integrations.configs, integration._id).map((config) => stopChannel(provider, config));
        }),
    );
    return tally(outcomes);
}

async function stopChannel(provider: ReturnType<typeof buildCalendarProvider>, config: CalendarSyncConfigInterface): Promise<Outcome> {
    try {
        await withTimeout(provider.stopWatch(config.webhookChannelId ?? '', config.webhookResourceId ?? ''), bestEffortStepTimeoutMs, 'stopWatch');
        return 'ok';
    } catch (err) {
        console.warn(`[delete-user] stopWatch failed | config=${config._id}`, err);
        return 'failed';
    }
}

interface GoogleTokens {
    refreshToken: string | null;
    accessToken: string | null;
    /** The Google account the tokens belong to (lowercased), when known — the key for the shared-grant check. */
    accountEmail?: string;
}

/**
 * Revokes the calendar integrations' grants and the Google sign-in grant, so Google's permission page
 * no longer lists the app. A grant is skipped when ANOTHER GTD user has connected the same Google
 * account: Google revokes per (client, Google account), so it would kill that user's refresh token too.
 */
async function revokeGoogleGrants(owner: UserIdentity, integrations: IntegrationsForDeletion, signInTokens: GoogleTokens[]): Promise<AttemptTally> {
    const outcomes = await Promise.all([...integrations.decrypted, ...signInTokens].map((tokens) => revokeUnlessShared(owner.userId, tokens)));
    // Undecryptable integrations never reached Google — they count as failures, not silent omissions.
    return tally([...outcomes, ...Array.from({ length: integrations.undecryptable }, (): Outcome => 'failed')]);
}

async function revokeUnlessShared(userId: string, tokens: GoogleTokens): Promise<Outcome> {
    if (await calendarIntegrationsDAO.isGoogleAccountUsedByOtherUser(tokens.accountEmail, userId)) {
        // No email in the log line — server logs must never carry addresses (see logRedaction.test.ts).
        console.log(`[delete-user] leaving a Google grant in place — another account still uses it | userId=${userId}`);
        return 'skipped';
    }
    return asOutcome(await revokeGoogleGrant(tokens));
}

function asOutcome(outcome: GoogleTokenRevokeOutcome): Outcome {
    if (outcome === 'failed') return 'failed';
    if (outcome === 'skipped') return 'skipped';
    return 'ok';
}

function specFor(collection: string): UserCollectionSpec {
    const spec = USER_DATA_COLLECTIONS.find((candidate) => candidate.collection === collection);
    if (!spec) throw new Error(`userDataInventory is missing the ${collection} collection`);
    return spec;
}

/** Better Auth's Google `account` rows hold sign-in tokens, encrypted at rest once `encryptOAuthTokens` is on. */
async function readGoogleSignInTokens(owner: UserIdentity): Promise<GoogleTokens[]> {
    const rows = await db
        .collection<{ accessToken?: string | null; refreshToken?: string | null }>('account')
        .find({ ...specFor('account').filter(owner), providerId: 'google' })
        .toArray();
    return Promise.all(
        rows.map(async (row) => ({
            refreshToken: await readBetterAuthToken(row.refreshToken),
            accessToken: await readBetterAuthToken(row.accessToken),
            // The sign-in grant belongs to the Google account the user signed in with — their own email.
            ...(owner.email ? { accountEmail: owner.email } : {}),
        })),
    );
}

// ── Row deletion ──────────────────────────────────────────────────────────────

async function deleteOwnedRows(owner: UserIdentity, include: (spec: UserCollectionSpec) => boolean): Promise<Record<string, number>> {
    const counts = await Promise.all(USER_DATA_COLLECTIONS.filter(include).map(async (spec) => [spec.collection, await deleteForSpec(spec, owner)] as const));
    return Object.fromEntries(counts);
}

function deleteForSpec(spec: UserCollectionSpec, owner: UserIdentity): Promise<number> {
    if (spec.deletion === 'sharedDevicePushSubscription') {
        return releasePushSubscriptions(owner.userId, { dryRun: false });
    }
    return deleteRows(spec.collection, spec.filter(owner));
}

/**
 * A push subscription is one row per DEVICE; its `user` is merely who registered it, and fan-out
 * joins through `deviceUsers`. Deleting it whenever the registrant is deleted would silence
 * notifications for every other account on that device. So: drop the subscription only for devices
 * that no longer host anyone, and hand the others over to a remaining account. Order-independent
 * with respect to the user's own `deviceUsers` rows — they are filtered out of the heir lookup.
 * Returns how many rows were (or, dry, would be) deleted.
 */
async function releasePushSubscriptions(userId: string, options: { dryRun: boolean }): Promise<number> {
    const subscriptions = await pushSubscriptionsDAO.findArray({ user: userId });
    const deletedCounts = await Promise.all(
        subscriptions.map(async (subscription) => {
            const [heir] = (await deviceUsersDAO.findUsersByDevice(subscription._id)).filter((row) => row.userId !== userId);
            if (options.dryRun) {
                return heir ? 0 : 1;
            }
            if (!heir) {
                return deleteRows('pushSubscriptions', { _id: subscription._id, user: userId });
            }
            await pushSubscriptionsDAO.updateOne({ _id: subscription._id }, { $set: { user: heir.userId } });
            return 0;
        }),
    );
    return deletedCounts.reduce((sum, count) => sum + count, 0);
}

async function deleteRows(collection: string, filter: Document): Promise<number> {
    const result = await db.collection(collection).deleteMany(filter);
    return result.deletedCount;
}

// ── Dry run ───────────────────────────────────────────────────────────────────

async function buildDryRunReport(owner: UserIdentity, integrations: IntegrationsForDeletion): Promise<DeletionReport> {
    const liveChannelCount = integrations.decrypted.reduce((sum, integration) => sum + liveChannels(integrations.configs, integration._id).length, 0);
    const googleAccounts = await db.collection('account').countDocuments({ ...specFor('account').filter(owner), providerId: 'google' });
    const counts = await Promise.all(
        [...USER_DATA_COLLECTIONS, USER_ROW_SPEC].map(async (spec) => [spec.collection, await countForDryRun(spec, owner)] as const),
    );
    return {
        userId: owner.userId,
        email: owner.email,
        dryRun: true,
        webhookChannels: { ...emptyTally(), attempted: liveChannelCount },
        googleTokenRevocations: { ...emptyTally(), attempted: integrations.decrypted.length + integrations.undecryptable + googleAccounts },
        deleted: Object.fromEntries(counts),
        tombstoneWritten: false,
        sseConnectionsClosed: 0,
    };
}

/** Dry-run counts follow the real deletion strategy, so a handed-over push subscription is not reported as a deletion. */
function countForDryRun(spec: UserCollectionSpec, owner: UserIdentity): Promise<number> {
    if (spec.deletion === 'sharedDevicePushSubscription') {
        return releasePushSubscriptions(owner.userId, { dryRun: true });
    }
    return db.collection(spec.collection).countDocuments(spec.filter(owner));
}
