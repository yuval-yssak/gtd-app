import type { IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// evaporateUserAndRecover touches the Better Auth client only on the active-account path; a stub
// keeps the module importable in Node and lets the pivot test assert the cookie hand-off.
vi.mock('../lib/authClient', () => {
    const setActive = vi.fn(async () => undefined);
    const listDeviceSessions = vi.fn(async () => ({ data: [{ user: { id: 'user-b' }, session: { token: 'token-b' } }] }));
    const signOut = vi.fn(async () => undefined);
    return { authClient: { signOut, multiSession: { setActive, listDeviceSessions } } };
});

import { ACCOUNT_EVAPORATED_EVENT, ACCOUNT_EVAPORATED_STORAGE_KEY } from '../contexts/accountEvaporatedEvents';
import { flagAccountNeedsReauth, isAccountFlaggedForReauth, resetAccountReauthStore } from '../contexts/accountReauthEvents';
import { getActiveAccount, getAllAccounts } from '../db/accountHelpers';
import { evaporateUser, evaporateUserAndRecover, evaporateUserAndRecoverGated, setPushUnsubscribeTimeoutMsForTests } from '../db/evaporateUser';
import { authClient } from '../lib/authClient';
import type { MyDB, StoredAccount } from '../types/MyDB';
import { openTestDB } from './openTestDB';

const NOW = '2026-10-04T10:00:00.000Z';

function makeAccount(id: string, addedAt: number): StoredAccount {
    return { id, email: `${id}@example.com`, name: `User ${id}`, image: null, provider: 'google', addedAt };
}

/** Seeds one row of every user-scoped store for `userId`, so a wipe has something in each to miss. */
async function seedUserRows(db: IDBPDatabase<MyDB>, userId: string): Promise<void> {
    await db.put('items', { _id: `item-${userId}`, userId, status: 'inbox', title: `Item ${userId}`, createdTs: NOW, updatedTs: NOW });
    await db.put('routines', {
        _id: `routine-${userId}`,
        userId,
        title: `Routine ${userId}`,
        routineType: 'nextAction',
        rrule: 'FREQ=DAILY',
        template: {},
        active: true,
        createdTs: NOW,
        updatedTs: NOW,
    });
    await db.put('people', { _id: `person-${userId}`, userId, name: `Person ${userId}`, createdTs: NOW, updatedTs: NOW });
    await db.put('workContexts', { _id: `ctx-${userId}`, userId, name: `Ctx ${userId}`, createdTs: NOW, updatedTs: NOW });
    await db.put('reviewInboxes', { _id: `ri-${userId}`, userId, name: `Inbox ${userId}`, order: 0, createdTs: NOW, updatedTs: NOW });
    await db.put('itemBriefs', {
        _id: `item-${userId}`,
        userId,
        itemId: `item-${userId}`,
        text: 'brief',
        origin: 'user',
        sourceHash: 'h',
        generatedTs: NOW,
        createdTs: NOW,
        updatedTs: NOW,
    });
    await db.put('syncOperations', { userId, entityType: 'item', entityId: `item-${userId}`, opType: 'create', queuedAt: NOW, snapshot: null });
    await db.put('syncCursors', { userId, lastSyncedTs: NOW, lastSyncedId: '' });
    await db.put('drafts', { key: `inboxCapture:${userId}`, kind: 'inboxCapture', userId, title: 'draft', notes: '', updatedTs: NOW });
}

interface UserRowCounts {
    items: number;
    routines: number;
    people: number;
    workContexts: number;
    reviewInboxes: number;
    itemBriefs: number;
    syncOps: number;
    hasCursor: boolean;
    drafts: number;
    hasAccount: boolean;
}

async function countUserRows(db: IDBPDatabase<MyDB>, userId: string): Promise<UserRowCounts> {
    const [items, routines, people, workContexts, reviewInboxes, itemBriefs, ops, cursor, drafts, account] = await Promise.all([
        db.getAllFromIndex('items', 'userId', userId),
        db.getAllFromIndex('routines', 'userId', userId),
        db.getAllFromIndex('people', 'userId', userId),
        db.getAllFromIndex('workContexts', 'userId', userId),
        db.getAllFromIndex('reviewInboxes', 'userId', userId),
        db.getAllFromIndex('itemBriefs', 'userId', userId),
        db.getAll('syncOperations'),
        db.get('syncCursors', userId),
        db.getAll('drafts'),
        db.get('accounts', userId),
    ]);
    return {
        items: items.length,
        routines: routines.length,
        people: people.length,
        workContexts: workContexts.length,
        reviewInboxes: reviewInboxes.length,
        itemBriefs: itemBriefs.length,
        syncOps: ops.filter((op) => op.userId === userId).length,
        hasCursor: cursor !== undefined,
        drafts: drafts.filter((draft) => draft.userId === userId).length,
        hasAccount: account !== undefined,
    };
}

const EMPTY: UserRowCounts = {
    items: 0,
    routines: 0,
    people: 0,
    workContexts: 0,
    reviewInboxes: 0,
    itemBriefs: 0,
    syncOps: 0,
    hasCursor: false,
    drafts: 0,
    hasAccount: false,
};
const FULL: UserRowCounts = {
    ...EMPTY,
    items: 1,
    routines: 1,
    people: 1,
    workContexts: 1,
    reviewInboxes: 1,
    itemBriefs: 1,
    syncOps: 1,
    hasCursor: true,
    drafts: 1,
    hasAccount: true,
};

let db: IDBPDatabase<MyDB>;

beforeEach(async () => {
    db = await openTestDB();
    await db.put('deviceMeta', { _id: 'local', deviceId: 'dev-test', flushingTs: null });
    await db.put('accounts', makeAccount('user-a', 1));
    await db.put('accounts', makeAccount('user-b', 2));
    await seedUserRows(db, 'user-a');
    await seedUserRows(db, 'user-b');
    vi.stubGlobal('window', { location: { href: '/inbox' }, dispatchEvent: vi.fn() });
});

afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    resetAccountReauthStore();
    setPushUnsubscribeTimeoutMsForTests();
    db.close();
});

/**
 * Installs a fake service-worker registration whose push subscription records unsubscribe calls, with
 * notification permission granted (the unsubscribe step is skipped otherwise). `ready` is a getter so
 * tests can assert whether it was awaited at all.
 */
function stubPushSubscription(unsubscribe: () => Promise<boolean>, options: { permission?: NotificationPermission; ready?: Promise<unknown> } = {}) {
    const readyAccess = vi.fn(() => options.ready ?? Promise.resolve({ pushManager: { getSubscription: async () => ({ unsubscribe }) } }));
    vi.stubGlobal('navigator', {
        onLine: true,
        serviceWorker: {
            get ready() {
                return readyAccess();
            },
        },
    });
    vi.stubGlobal('Notification', { permission: options.permission ?? 'granted' });
    return { readyAccess };
}

describe('evaporateUser', () => {
    it('drops every row of the deleted user and nothing of the other user; deviceMeta survives', async () => {
        await db.put('activeAccount', { userId: 'user-b' }, 'active');

        const result = await evaporateUser(db, 'user-a');

        expect(result).toEqual({ wasActive: false, needsRecovery: false, nextAccount: makeAccount('user-b', 2) });
        expect(await countUserRows(db, 'user-a')).toEqual(EMPTY);
        expect(await countUserRows(db, 'user-b')).toEqual(FULL);
        expect(await db.get('deviceMeta', 'local')).toEqual({ _id: 'local', deviceId: 'dev-test', flushingTs: null });
        // user-b stays the active account — only user-a's pointer would have been cleared.
        expect((await getActiveAccount(db))?.id).toBe('user-b');
    });

    it('reports wasActive and the next account when the active account is evaporated', async () => {
        await db.put('activeAccount', { userId: 'user-a' }, 'active');

        const result = await evaporateUser(db, 'user-a');

        expect(result.wasActive).toBe(true);
        expect(result.needsRecovery).toBe(true);
        expect(result.nextAccount?.id).toBe('user-b');
        // The pointer is cleared; the CALLER decides whether to pivot — evaporateUser itself must not.
        expect(await getActiveAccount(db)).toBeUndefined();
    });

    it('returns no next account when the deleted user was the only one', async () => {
        await db.delete('accounts', 'user-b');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');

        const result = await evaporateUser(db, 'user-a');

        expect(result).toEqual({ wasActive: true, needsRecovery: true, nextAccount: undefined });
        expect(await getAllAccounts(db)).toEqual([]);
    });

    it('flags recovery when another tab already removed the active pointer (stranded second tab)', async () => {
        // Tab 1 evaporated user-a (the active account) first; this tab receives the same SSE event.
        await db.delete('activeAccount', 'active');

        const result = await evaporateUser(db, 'user-a');

        expect(result).toEqual({ wasActive: false, needsRecovery: true, nextAccount: makeAccount('user-b', 2) });
    });

    it('clears a stale "needs re-login" flag for the deleted account', async () => {
        await db.put('activeAccount', { userId: 'user-b' }, 'active');
        flagAccountNeedsReauth('user-a');
        flagAccountNeedsReauth('user-b');

        await evaporateUser(db, 'user-a');

        expect(isAccountFlaggedForReauth('user-a')).toBe(false);
        expect(isAccountFlaggedForReauth('user-b')).toBe(true);
    });

    it('is idempotent — evaporating an unknown user changes nothing', async () => {
        await db.put('activeAccount', { userId: 'user-a' }, 'active');

        const result = await evaporateUser(db, 'user-zzz');

        expect(result).toEqual({ wasActive: false, needsRecovery: false, nextAccount: makeAccount('user-a', 1) });
        expect(await countUserRows(db, 'user-a')).toEqual(FULL);
        expect(await countUserRows(db, 'user-b')).toEqual(FULL);
    });
});

describe('evaporateUserAndRecover', () => {
    it('active account deleted with another signed in → pivots IDB + cookie to the survivor and reloads to /', async () => {
        await db.put('activeAccount', { userId: 'user-a' }, 'active');

        const result = await evaporateUserAndRecover(db, 'user-a');

        expect(result).toEqual({ wasActive: true, navigated: true });
        expect((await getActiveAccount(db))?.id).toBe('user-b');
        expect(authClient.multiSession.setActive).toHaveBeenCalledExactlyOnceWith({ sessionToken: 'token-b' });
        expect(window.location.href).toBe('/');
        expect(authClient.signOut).not.toHaveBeenCalled();
    });

    it('active account deleted with nobody else → signs out and lands on /login', async () => {
        await db.delete('accounts', 'user-b');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');

        const result = await evaporateUserAndRecover(db, 'user-a');

        expect(result).toEqual({ wasActive: true, navigated: true });
        expect(authClient.signOut).toHaveBeenCalledOnce();
        expect(window.location.href).toBe('/login');
        expect(authClient.multiSession.setActive).not.toHaveBeenCalled();
    });

    it('non-active account deleted → no navigation, announces the evaporation instead', async () => {
        await db.put('activeAccount', { userId: 'user-b' }, 'active');

        const result = await evaporateUserAndRecover(db, 'user-a');

        expect(result).toEqual({ wasActive: false, navigated: false });
        expect(window.location.href).toBe('/inbox');
        expect(authClient.multiSession.setActive).not.toHaveBeenCalled();
        const dispatched = vi.mocked(window.dispatchEvent).mock.calls.map(([event]) => event as CustomEvent<{ userId: string }>);
        expect(dispatched).toHaveLength(1);
        const [event] = dispatched;
        if (!event) throw new Error('expected one dispatched event');
        expect(event.type).toBe(ACCOUNT_EVAPORATED_EVENT);
        expect(event.detail).toEqual({ userId: 'user-a' });
        expect(await countUserRows(db, 'user-b')).toEqual(FULL);
    });

    it('still pivots when the session cookie hand-off fails (boot reconcile repairs it later)', async () => {
        await db.put('activeAccount', { userId: 'user-a' }, 'active');
        vi.mocked(authClient.multiSession.listDeviceSessions).mockRejectedValueOnce(new Error('offline'));

        await evaporateUserAndRecover(db, 'user-a');

        expect((await getActiveAccount(db))?.id).toBe('user-b');
        expect(window.location.href).toBe('/');
    });

    it('stranded second tab: active pointer already gone → recovers (pivots to the survivor) instead of staying on a dead route', async () => {
        await db.delete('activeAccount', 'active');

        const result = await evaporateUserAndRecover(db, 'user-a');

        expect(result).toEqual({ wasActive: false, navigated: true });
        expect((await getActiveAccount(db))?.id).toBe('user-b');
        expect(window.location.href).toBe('/');
    });

    it('dedupes concurrent calls for the same user — one wipe, one navigation, same result for both callers', async () => {
        await db.put('activeAccount', { userId: 'user-a' }, 'active');

        const [first, second] = await Promise.all([evaporateUserAndRecover(db, 'user-a'), evaporateUserAndRecoverGated(db, 'user-a')]);

        expect(first).toEqual({ wasActive: true, navigated: true });
        expect(second).toBe(first);
        expect(authClient.multiSession.listDeviceSessions).toHaveBeenCalledTimes(1);
        expect(authClient.multiSession.setActive).toHaveBeenCalledTimes(1);
    });

    it('unsubscribes this device from push only when the active account was evaporated', async () => {
        const unsubscribe = vi.fn(async () => true);
        stubPushSubscription(unsubscribe);
        await db.put('activeAccount', { userId: 'user-b' }, 'active');

        await evaporateUserAndRecover(db, 'user-a');
        expect(unsubscribe).not.toHaveBeenCalled();

        await evaporateUserAndRecover(db, 'user-b');
        expect(unsubscribe).toHaveBeenCalledOnce();
        expect(window.location.href).toBe('/login');
    });

    it('still navigates when `serviceWorker.ready` never settles (no active worker) — the unsubscribe is bounded by a deadline', async () => {
        // A promise that never resolves — exactly what `ready` does on a page without an active worker.
        stubPushSubscription(async () => true, { ready: new Promise(() => undefined) });
        setPushUnsubscribeTimeoutMsForTests(20);
        await db.delete('accounts', 'user-b');
        await db.put('activeAccount', { userId: 'user-a' }, 'active');

        const result = await evaporateUserAndRecover(db, 'user-a');

        expect(result).toEqual({ wasActive: true, navigated: true });
        expect(window.location.href).toBe('/login');
    });

    it('never awaits `serviceWorker.ready` when notification permission was not granted (no push can exist)', async () => {
        const { readyAccess } = stubPushSubscription(async () => true, { permission: 'default' });
        await db.put('activeAccount', { userId: 'user-a' }, 'active');

        await evaporateUserAndRecover(db, 'user-a');

        expect(readyAccess).not.toHaveBeenCalled();
        expect(window.location.href).toBe('/');
    });

    it('still navigates when the push unsubscribe fails', async () => {
        stubPushSubscription(async () => {
            throw new Error('push gone');
        });
        await db.put('activeAccount', { userId: 'user-a' }, 'active');

        const result = await evaporateUserAndRecover(db, 'user-a');

        expect(result.navigated).toBe(true);
        expect(window.location.href).toBe('/');
    });

    it('broadcasts every evaporation to other tabs via localStorage, active or not', async () => {
        const setItem = vi.fn();
        vi.stubGlobal('localStorage', { setItem });
        await db.put('activeAccount', { userId: 'user-b' }, 'active');

        await evaporateUserAndRecover(db, 'user-a');
        await evaporateUserAndRecover(db, 'user-b');

        const broadcasts = setItem.mock.calls
            .filter(([key]) => key === ACCOUNT_EVAPORATED_STORAGE_KEY)
            .map(([, value]) => (JSON.parse(value as string) as { userId: string }).userId);
        expect(broadcasts).toEqual(['user-a', 'user-b']);
    });

    it('broadcasts to other tabs only AFTER the survivor is active (IDB pointer written AND cookie pivot done)', async () => {
        await db.put('activeAccount', { userId: 'user-a' }, 'active');
        const order: string[] = [];
        const pointerSeenAtBroadcast: Array<Promise<string | undefined>> = [];
        // A deliberately slow cookie pivot: a broadcast sent before it would be observable in `order`.
        vi.mocked(authClient.multiSession.setActive).mockImplementationOnce(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            order.push('setActive');
        });
        vi.stubGlobal('localStorage', {
            setItem: vi.fn((key: string) => {
                if (key === ACCOUNT_EVAPORATED_STORAGE_KEY) {
                    order.push('broadcast');
                    pointerSeenAtBroadcast.push(db.get('activeAccount', 'active').then((pointer) => pointer?.userId));
                }
            }),
        });

        await evaporateUserAndRecover(db, 'user-a');

        expect(order).toEqual(['setActive', 'broadcast']);
        expect(await Promise.all(pointerSeenAtBroadcast)).toEqual(['user-b']);
        expect(window.location.href).toBe('/');
    });
});
