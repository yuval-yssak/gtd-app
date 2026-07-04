import dayjs from 'dayjs';
import type { IDBPDatabase, IDBPTransaction } from 'idb';
import type { MyDB, OAuthProvider, StoredAccount } from '../types/MyDB';

/**
 * Upserts an account row, reconciling on the unique `email` index. The store is keyed by `id`
 * (Better Auth userId), but `email` carries a unique index — so a plain `put` throws
 * `ConstraintError` when the same email already exists under a DIFFERENT `id` (re-login where an
 * email now maps to a new userId, or a stale row from a prior identity). We delete any same-email
 * row whose `id` differs before writing the new one, all inside a single readwrite transaction so a
 * concurrent read never sees the email mapped to zero or two rows.
 *
 * Callers fan this out concurrently via `Promise.all` (useAccounts mirrors every device session,
 * AppDataProvider re-hydrates on load). That's safe: IDB serializes overlapping readwrite
 * transactions on the same store, and `listDeviceSessions` never returns two sessions sharing an
 * email — so no two concurrent upserts contend for the same email row.
 *
 * Note: this reconciles the `accounts` store only. If the deleted stale row happened to be the
 * `activeAccount` pointer, the caller's `setActiveAccount` (re-login) or session list (multi-session
 * mirror) is what re-points it — kept out of here to preserve single responsibility.
 */
export async function upsertAccount(account: StoredAccount, db: IDBPDatabase<MyDB>): Promise<void> {
    const tx = db.transaction('accounts', 'readwrite');
    const store = tx.objectStore('accounts');
    const existingByEmail = await store.index('email').get(account.email);
    if (existingByEmail && existingByEmail.id !== account.id) {
        await store.delete(existingByEmail.id);
    }
    await store.put(account);
    await tx.done;
}

/** Shape of the Better Auth `getSession()` user object we care about. Keep `image` permissive
 *  (string | null | undefined) to match Better Auth's actual return type, which uses an
 *  optional null-or-string field. `provider` is widened with a defensive cast at the call
 *  site since Better Auth doesn't expose it on the session user. */
export type SessionLike = { user: { id: string; email: string; name: string; image?: string | null | undefined } };

/**
 * Write the local `accounts` + `activeAccount` records from a Better Auth session. Shared by
 * the OAuth callback path (auth.callback.tsx) and the authenticated-route guard's recovery
 * path that handles "user cleared site data while the server cookie remained" — both must
 * mirror the same persisted shape so subsequent boots converge.
 */
export async function hydrateAccountFromSession(db: IDBPDatabase<MyDB>, session: SessionLike): Promise<void> {
    // Better Auth doesn't expose the OAuth provider on the session user; default to 'google'.
    // The chosen value is cosmetic — server-side account-link logic is what actually drives
    // identity, so a wrong default here only affects the local UI hint.
    const provider: OAuthProvider = (session.user as { provider?: OAuthProvider }).provider ?? 'google';
    await upsertAccount(
        {
            id: session.user.id,
            email: session.user.email,
            name: session.user.name,
            image: session.user.image ?? null,
            provider,
            addedAt: dayjs().valueOf(),
        },
        db,
    );
    await setActiveAccount(session.user.id, db);
}

export async function setActiveAccount(userId: string, db: IDBPDatabase<MyDB>): Promise<void> {
    await db.put('activeAccount', { userId }, 'active');
}

export async function getActiveAccount(db: IDBPDatabase<MyDB>): Promise<StoredAccount | undefined> {
    const active = await db.get('activeAccount', 'active');
    if (!active) return undefined;
    return db.get('accounts', active.userId);
}

export async function getAllAccounts(db: IDBPDatabase<MyDB>): Promise<StoredAccount[]> {
    const all = await db.getAll('accounts');
    // Sort oldest-added first so order is stable across reads
    return all.sort((a, b) => a.addedAt - b.addedAt);
}

/**
 * Returns every account currently signed in on this device. Same as `getAllAccounts` semantically —
 * the IDB `accounts` store is mirrored from `multiSession.listDeviceSessions()` on every load
 * (see useAccounts.ts), so an account is in IDB iff a server-side session for it exists on this
 * device. The dedicated name is kept so call sites in the unified-view path can read as the
 * domain concept ("logged-in accounts") rather than "all known accounts".
 */
export async function getLoggedInAccounts(db: IDBPDatabase<MyDB>): Promise<StoredAccount[]> {
    return getAllAccounts(db);
}

export async function getLoggedInUserIds(db: IDBPDatabase<MyDB>): Promise<string[]> {
    const accounts = await getLoggedInAccounts(db);
    return accounts.map((a) => a.id);
}

export async function removeAccount(userId: string, db: IDBPDatabase<MyDB>): Promise<void> {
    await db.delete('accounts', userId);
    const active = await db.get('activeAccount', 'active');
    if (active?.userId === userId) {
        await db.delete('activeAccount', 'active');
    }
}

export async function clearAllAccounts(db: IDBPDatabase<MyDB>): Promise<void> {
    await db.clear('accounts');
    await db.delete('activeAccount', 'active');
}

/**
 * Wipes every IDB row owned by a single user when their session ends — items, routines, people,
 * workContexts, the per-user sync cursor, and any sync operations still queued under that userId.
 * `deviceMeta` and other accounts' rows are intentionally untouched: the deviceId must outlive
 * any single sign-out so push subscriptions and operation log purges stay attached to the same
 * physical device, and other logged-in accounts on this browser must keep their data.
 *
 * Runs in a single multi-store readwrite transaction so a tab close mid-wipe can never leave
 * orphan rows belonging to a userId that's no longer in `accounts`.
 */
export async function wipeUserData(userId: string, db: IDBPDatabase<MyDB>): Promise<void> {
    const tx = db.transaction(['items', 'routines', 'people', 'workContexts', 'syncOperations', 'syncCursors', 'drafts'], 'readwrite');
    await Promise.all([
        deleteByUserIdIndexInTx(tx, 'items', userId),
        deleteByUserIdIndexInTx(tx, 'routines', userId),
        deleteByUserIdIndexInTx(tx, 'people', userId),
        deleteByUserIdIndexInTx(tx, 'workContexts', userId),
        deleteSyncOperationsForUserInTx(tx, userId),
        tx.objectStore('syncCursors').delete(userId),
        deleteDraftsForUserInTx(tx, userId),
    ]);
    await tx.done;
}

type UserScopedStore = 'items' | 'routines' | 'people' | 'workContexts';

type WipeStores = Array<'items' | 'routines' | 'people' | 'workContexts' | 'syncOperations' | 'syncCursors' | 'drafts'>;
type WipeTx = IDBPTransaction<MyDB, WipeStores, 'readwrite'>;

async function deleteByUserIdIndexInTx(tx: WipeTx, store: UserScopedStore, userId: string): Promise<void> {
    let cursor = await tx.objectStore(store).index('userId').openCursor(IDBKeyRange.only(userId));
    while (cursor) {
        await cursor.delete();
        cursor = await cursor.continue();
    }
}

async function deleteDraftsForUserInTx(tx: WipeTx, userId: string): Promise<void> {
    // Drafts carry the user's unsaved text — they must not survive the account's sign-out.
    // No userId index; the store holds at most a handful of rows, so a full scan is fine.
    let cursor = await tx.objectStore('drafts').openCursor();
    while (cursor) {
        if (cursor.value.userId === userId) {
            await cursor.delete();
        }
        cursor = await cursor.continue();
    }
}

async function deleteSyncOperationsForUserInTx(tx: WipeTx, userId: string): Promise<void> {
    // syncOperations has no userId index — we iterate the whole store and drop matching rows.
    // The queue is normally tiny (only unflushed ops); a full scan is fine.
    let cursor = await tx.objectStore('syncOperations').openCursor();
    while (cursor) {
        if (cursor.value.userId === userId) {
            await cursor.delete();
        }
        cursor = await cursor.continue();
    }
}
