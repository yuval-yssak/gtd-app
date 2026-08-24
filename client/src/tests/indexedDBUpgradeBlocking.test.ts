import { IDBFactory } from 'fake-indexeddb';
import { openDB } from 'idb';
import { describe, expect, it, vi } from 'vitest';
import { openAppDB, withAppDB } from '../db/indexedDB';

// Same swap pattern as indexedDBMigration.test.ts — each test gets an isolated IDBFactory.
async function withFreshIDB<T>(fn: () => Promise<T>): Promise<T> {
    const prev = globalThis.indexedDB;
    globalThis.indexedDB = new IDBFactory();
    try {
        return await fn();
    } finally {
        globalThis.indexedDB = prev;
    }
}

// A v-next open hangs forever if nothing releases the current connection; racing a short timer
// turns that regression into a fast, descriptive failure instead of a suite-timeout that reads
// like flake. The timer is cleared when the open wins so the losing branch can't surface as an
// unhandled rejection after the test passes.
async function openV9OrFailFast() {
    // let: the timer handle must escape the promise executor so the finally can clear it
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('v9 open stayed blocked — the existing connection was never released')), 1000);
    });
    try {
        return await Promise.race([openDB('gtd-app', 9, { upgrade() {} }), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

describe('openAppDB upgrade blocking', () => {
    it('reports a blocked upgrade and resolves once the stale connection closes', async () => {
        await withFreshIDB(async () => {
            // Simulate a previous deployed bundle: an older schema version held open with no
            // versionchange handler (pre-fix bundles registered none, so they never self-close).
            const staleConnection = await openDB('gtd-app', 7, { upgrade() {} });

            const onUpgradeBlocked = vi.fn();
            const opening = openAppDB({ onUpgradeBlocked });
            await vi.waitFor(() => expect(onUpgradeBlocked).toHaveBeenCalled());

            staleConnection.close();
            const db = await opening;
            expect(db.version).toBe(8);
            db.close();
        });
    });

    it('does not report a blocked upgrade when no stale connection exists', async () => {
        await withFreshIDB(async () => {
            const onUpgradeBlocked = vi.fn();
            const db = await openAppDB({ onUpgradeBlocked });
            expect(onUpgradeBlocked).not.toHaveBeenCalled();
            db.close();
        });
    });

    it('closes its own connection when a newer version elsewhere requests an upgrade', async () => {
        await withFreshIDB(async () => {
            const ours = await openAppDB();
            const upgraded = await openV9OrFailFast();
            expect(upgraded.version).toBe(9);
            // Proves the release came from our `blocking` handler closing the connection —
            // a transaction on a closed connection throws InvalidStateError synchronously.
            expect(() => ours.transaction('accounts')).toThrow();
            upgraded.close();
        });
    });
});

describe('withAppDB', () => {
    it('releases the connection even when the task throws', async () => {
        await withFreshIDB(async () => {
            await expect(
                withAppDB(async () => {
                    throw new Error('boom');
                }),
            ).rejects.toThrow('boom');
            // A v9 open completing proves nothing is still holding the v8 connection.
            const upgraded = await openV9OrFailFast();
            expect(upgraded.version).toBe(9);
            upgraded.close();
        });
    });

    it('runs the task against the opened DB and releases on success', async () => {
        await withFreshIDB(async () => {
            const version = await withAppDB(async (db) => db.version);
            expect(version).toBe(8);
            const upgraded = await openV9OrFailFast();
            expect(upgraded.version).toBe(9);
            upgraded.close();
        });
    });
});
