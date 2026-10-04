import { type Document, ObjectId } from 'mongodb';

/**
 * THE inventory of where a user's data lives. Account deletion (`deleteUserCompletely.ts`) and
 * data export (`exportUserData.ts`) are both driven from this one list so the two cannot drift:
 * a collection that is erased is also exported (or explicitly omitted, with the reason beside
 * it), and `tests/userDataInventory.test.ts` enumerates every DAO under `src/dataAccess/` plus
 * Better Auth's collections and fails when one is neither listed here nor in
 * `NOT_USER_SCOPED_COLLECTIONS` — so adding a collection forces a deletion + export decision.
 *
 * Owner fields differ per collection (`items.user` but `deviceUsers.userId`, `sentEmails.userId`,
 * `entityMoves.fromUserId|toUserId`): each entry spells out its own filter instead of assuming `user`.
 */

export interface UserIdentity {
    userId: string;
    /** For reporting (the CLI confirmation prompt); null when the user row is already gone. No filter keys on it. */
    email: string | null;
}

export type ExportPolicy =
    /** Every field is the user's own data. */
    | { kind: 'full' }
    /** Exported after `redact` strips credentials (tokens, hashes, push keys). */
    | { kind: 'redacted'; redact: (doc: Document) => Document }
    /** Not exported; `reason` is shown to the user in the export's `omitted` map. */
    | { kind: 'omitted'; reason: string };

/**
 * How deletion treats the collection. `byFilter` (the default) is a plain `deleteMany(filter)`;
 * `sharedDevicePushSubscription` is the one row shape keyed by DEVICE rather than user, handled
 * in `deleteUserCompletely.ts` so another account on the same device keeps its notifications.
 */
export type DeletionStrategy = 'byFilter' | 'sharedDevicePushSubscription';

export interface UserCollectionSpec {
    collection: string;
    /** Human description of the owner key — documentation, and what the inventory test seeds. */
    ownedBy: string;
    /** A raw Mongo filter. Typed as `Document` (not `Filter<Document>`) because Better Auth ids are a string|ObjectId union the driver's `_id` typing rejects. */
    filter: (owner: UserIdentity) => Document;
    export: ExportPolicy;
    deletion?: DeletionStrategy;
}

/**
 * Better Auth's mongodb adapter stores ids as `ObjectId` for OAuth-created users while test and
 * dev-login seeds use plain strings — and the two shapes coexist in one database. Match both.
 */
export function betterAuthIdFilter(userId: string): { $in: Array<string | ObjectId> } {
    const isObjectIdHex = /^[a-f0-9]{24}$/i.test(userId);
    return { $in: isObjectIdHex ? [userId, new ObjectId(userId)] : [userId] };
}

function omitFields(...fields: string[]): (doc: Document) => Document {
    return (doc) => Object.fromEntries(Object.entries(doc).filter(([key]) => !fields.includes(key)));
}

const byUser = (owner: UserIdentity): Document => ({ user: owner.userId });
const byUserId = (owner: UserIdentity): Document => ({ userId: owner.userId });
const byBetterAuthUserId = (owner: UserIdentity): Document => ({ userId: betterAuthIdFilter(owner.userId) });

/** Everything the user owns EXCEPT the Better Auth `user` row, which deletion removes last (see `USER_ROW_SPEC`). */
export const USER_DATA_COLLECTIONS: readonly UserCollectionSpec[] = [
    // ── Synced entities ───────────────────────────────────────────────────────
    { collection: 'items', ownedBy: 'user', filter: byUser, export: { kind: 'full' } },
    { collection: 'routines', ownedBy: 'user', filter: byUser, export: { kind: 'full' } },
    { collection: 'people', ownedBy: 'user', filter: byUser, export: { kind: 'full' } },
    { collection: 'workContexts', ownedBy: 'user', filter: byUser, export: { kind: 'full' } },
    { collection: 'reviewInboxes', ownedBy: 'user', filter: byUser, export: { kind: 'full' } },
    { collection: 'itemBriefs', ownedBy: 'user', filter: byUser, export: { kind: 'full' } },
    // ── Sync bookkeeping ──────────────────────────────────────────────────────
    {
        collection: 'operations',
        ownedBy: 'user',
        filter: byUser,
        export: {
            kind: 'omitted',
            reason: 'Replication log: every row is a snapshot of an entity already exported above, plus the device id and time of the change.',
        },
    },
    { collection: 'deviceSyncState', ownedBy: 'user', filter: byUser, export: { kind: 'full' } },
    { collection: 'deviceUsers', ownedBy: 'userId', filter: byUserId, export: { kind: 'full' } },
    {
        collection: 'entityMoves',
        ownedBy: 'fromUserId or toUserId',
        filter: (owner) => ({ $or: [{ fromUserId: owner.userId }, { toUserId: owner.userId }] }),
        export: { kind: 'full' },
    },
    // ── Notifications ─────────────────────────────────────────────────────────
    {
        collection: 'pushSubscriptions',
        // `_id` is the deviceId and `user` is only "who registered it": pushes fan out through the
        // deviceUsers join, so a device shared by two accounts has ONE row that both rely on.
        ownedBy: 'user (registrant; row is per device)',
        filter: byUser,
        // The endpoint URL and the p256dh/auth keys are the credentials that let a server push to the browser.
        export: { kind: 'redacted', redact: omitFields('endpoint', 'keys') },
        deletion: 'sharedDevicePushSubscription',
    },
    { collection: 'sentEmails', ownedBy: 'userId', filter: byUserId, export: { kind: 'full' } },
    // ── Google Calendar ───────────────────────────────────────────────────────
    {
        collection: 'calendarIntegrations',
        ownedBy: 'user',
        filter: byUser,
        export: { kind: 'redacted', redact: omitFields('accessToken', 'refreshToken') },
    },
    {
        collection: 'calendarSyncConfigs',
        ownedBy: 'user',
        filter: byUser,
        // The Google sync token is an opaque incremental-sync cursor, not user data.
        export: { kind: 'redacted', redact: omitFields('syncToken') },
    },
    // ── Public API, webhooks, MCP OAuth ───────────────────────────────────────
    { collection: 'apiTokens', ownedBy: 'user', filter: byUser, export: { kind: 'redacted', redact: omitFields('tokenHash') } },
    { collection: 'webhookSubscriptions', ownedBy: 'user', filter: byUser, export: { kind: 'redacted', redact: omitFields('secret') } },
    { collection: 'webhookDeliveries', ownedBy: 'user', filter: byUser, export: { kind: 'full' } },
    // `_id` of both OAuth rows is the sha256 of a secret the client holds (the code / refresh token).
    { collection: 'oauthAuthCodes', ownedBy: 'user', filter: byUser, export: { kind: 'redacted', redact: omitFields('_id', 'codeChallenge') } },
    // `rotatedToId` is the hash of the successor token — the live one — so it goes too.
    { collection: 'oauthRefreshTokens', ownedBy: 'user', filter: byUser, export: { kind: 'redacted', redact: omitFields('_id', 'rotatedToId') } },
    // ── AI ────────────────────────────────────────────────────────────────────
    { collection: 'claudeUsage', ownedBy: 'user', filter: byUser, export: { kind: 'full' } },
    // Batch rows themselves are cross-user (see NOT_USER_SCOPED_COLLECTIONS); only the per-user request identities are the user's.
    { collection: 'briefBatchRequests', ownedBy: 'user', filter: byUser, export: { kind: 'full' } },
    // ── Better Auth ───────────────────────────────────────────────────────────
    { collection: 'session', ownedBy: 'userId (string or ObjectId)', filter: byBetterAuthUserId, export: { kind: 'redacted', redact: omitFields('token') } },
    {
        collection: 'account',
        ownedBy: 'userId (string or ObjectId)',
        filter: byBetterAuthUserId,
        export: { kind: 'redacted', redact: omitFields('accessToken', 'refreshToken', 'idToken', 'password') },
    },
];

/** The Better Auth `user` row: deleted LAST, after the tombstone is written, so a crash mid-deletion never leaves an account without a tombstone. */
export const USER_ROW_SPEC: UserCollectionSpec = {
    collection: 'user',
    ownedBy: '_id (string or ObjectId)',
    filter: (owner) => ({ _id: betterAuthIdFilter(owner.userId) }),
    export: { kind: 'full' },
};

/** Collections that intentionally hold NO per-user rows. Listed so the inventory test can tell "not user data" from "forgotten". */
export const NOT_USER_SCOPED_COLLECTIONS: ReadonlyMap<string, string> = new Map([
    ['briefBatches', 'One Anthropic Message Batch per row, spanning many users; per-user identities live in briefBatchRequests.'],
    [
        'verification',
        'Better Auth 1.5.6 keys in-flight OAuth state by a random `identifier` (not by user or email) and expires it within minutes; no row can be attributed to a user.',
    ],
    ['oauthClients', 'RFC 7591 client registrations made by MCP clients — not owned by any user.'],
    ['deletedUsers', 'The tombstones themselves; written by deletion, kept forever on purpose.'],
]);

/** Every collection the inventory knows about, user-scoped or not. */
export function inventoriedCollectionNames(): Set<string> {
    return new Set([...USER_DATA_COLLECTIONS.map((spec) => spec.collection), USER_ROW_SPEC.collection, ...NOT_USER_SCOPED_COLLECTIONS.keys()]);
}

export function applyExportPolicy(spec: UserCollectionSpec, docs: Document[]): Document[] | null {
    switch (spec.export.kind) {
        case 'full':
            return docs;
        case 'redacted':
            return docs.map(spec.export.redact);
        case 'omitted':
            return null;
    }
}
