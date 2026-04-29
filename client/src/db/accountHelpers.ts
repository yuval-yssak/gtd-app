import dayjs from 'dayjs';
import type { IDBPDatabase } from 'idb';
import type { MyDB, OAuthProvider, StoredAccount } from '../types/MyDB';

export async function upsertAccount(account: StoredAccount, db: IDBPDatabase<MyDB>): Promise<void> {
    await db.put('accounts', account);
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
