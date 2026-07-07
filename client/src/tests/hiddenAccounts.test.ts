import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'gtd:hiddenAccountIds';

/** Minimal localStorage stub for the Node test env, backed by a Map the tests can inspect. */
function installLocalStorageStub(initial: Record<string, string> = {}) {
    const backing = new Map(Object.entries(initial));
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => backing.get(key) ?? null,
        setItem: (key: string, value: string) => {
            backing.set(key, value);
        },
        removeItem: (key: string) => {
            backing.delete(key);
        },
    });
    return backing;
}

/** Fresh module instance per test — the store caches its snapshot at module scope. */
async function importFreshStore() {
    vi.resetModules();
    return import('../contexts/hiddenAccounts');
}

describe('hiddenAccounts store', () => {
    beforeEach(() => {
        installLocalStorageStub();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('starts empty when nothing is persisted', async () => {
        const store = await importFreshStore();
        expect(store.getHiddenAccountIds()).toEqual([]);
    });

    it('toggle adds the account and persists it; a second toggle removes it', async () => {
        const backing = installLocalStorageStub();
        const store = await importFreshStore();

        store.toggleAccountHidden('user-b');
        expect(store.getHiddenAccountIds()).toEqual(['user-b']);
        expect(backing.get(STORAGE_KEY)).toBe('["user-b"]');

        store.toggleAccountHidden('user-b');
        expect(store.getHiddenAccountIds()).toEqual([]);
        expect(backing.get(STORAGE_KEY)).toBe('[]');
    });

    it('loads persisted ids at module init', async () => {
        installLocalStorageStub({ [STORAGE_KEY]: '["user-a","user-c"]' });
        const store = await importFreshStore();
        expect(store.getHiddenAccountIds()).toEqual(['user-a', 'user-c']);
    });

    it('treats corrupted or non-array persisted values as empty', async () => {
        installLocalStorageStub({ [STORAGE_KEY]: 'not-json{' });
        const corrupted = await importFreshStore();
        expect(corrupted.getHiddenAccountIds()).toEqual([]);

        installLocalStorageStub({ [STORAGE_KEY]: '{"a":1}' });
        const nonArray = await importFreshStore();
        expect(nonArray.getHiddenAccountIds()).toEqual([]);
    });

    it('drops non-string entries from a persisted array', async () => {
        installLocalStorageStub({ [STORAGE_KEY]: '["user-a", 42, null]' });
        const store = await importFreshStore();
        expect(store.getHiddenAccountIds()).toEqual(['user-a']);
    });

    it('getSnapshot is referentially stable between toggles (useSyncExternalStore contract)', async () => {
        const store = await importFreshStore();
        store.toggleAccountHidden('user-b');
        const first = store.getHiddenAccountIds();
        expect(store.getHiddenAccountIds()).toBe(first);
        store.toggleAccountHidden('user-c');
        expect(store.getHiddenAccountIds()).not.toBe(first);
    });

    it('notifies subscribers on toggle and stops after unsubscribe', async () => {
        const store = await importFreshStore();
        const onChange = vi.fn();
        const unsubscribe = store.subscribeHiddenAccounts(onChange);

        store.toggleAccountHidden('user-b');
        expect(onChange).toHaveBeenCalledTimes(1);

        unsubscribe();
        store.toggleAccountHidden('user-b');
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('cross-tab bridge installs its window listener once and applies storage events for our key only', async () => {
        type StorageListener = (event: { key: string | null }) => void;
        const listeners: StorageListener[] = [];
        vi.stubGlobal('window', {
            addEventListener: (_type: string, listener: StorageListener) => {
                listeners.push(listener);
            },
        });
        const backing = installLocalStorageStub();
        const store = await importFreshStore();

        store.ensureHiddenAccountsCrossTabBridge();
        store.ensureHiddenAccountsCrossTabBridge();
        expect(listeners).toHaveLength(1);
        const [onStorage] = listeners;
        if (!onStorage) throw new Error('expected one storage listener');

        const onChange = vi.fn();
        store.subscribeHiddenAccounts(onChange);

        // Another tab persisted a new hidden set — the bridge re-reads and notifies.
        backing.set(STORAGE_KEY, '["user-b"]');
        onStorage({ key: STORAGE_KEY });
        expect(store.getHiddenAccountIds()).toEqual(['user-b']);
        expect(onChange).toHaveBeenCalledTimes(1);

        // Storage events for unrelated keys are ignored.
        backing.set(STORAGE_KEY, '["user-c"]');
        onStorage({ key: 'some-other-key' });
        expect(store.getHiddenAccountIds()).toEqual(['user-b']);
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('cross-tab bridge is a no-op outside a browser', async () => {
        const store = await importFreshStore();
        expect(() => store.ensureHiddenAccountsCrossTabBridge()).not.toThrow();
    });

    it('resetHiddenAccountsStore clears both the snapshot and the persisted key', async () => {
        const backing = installLocalStorageStub();
        const store = await importFreshStore();
        store.toggleAccountHidden('user-b');

        store.resetHiddenAccountsStore();
        expect(store.getHiddenAccountIds()).toEqual([]);
        expect(backing.has(STORAGE_KEY)).toBe(false);
    });
});

describe('filterOutHiddenAccounts', () => {
    const entities = [
        { _id: '1', userId: 'user-a' },
        { _id: '2', userId: 'user-b' },
        { _id: '3', userId: 'user-a' },
    ];

    it('returns the same array reference when nothing is hidden', async () => {
        const store = await importFreshStore();
        expect(store.filterOutHiddenAccounts(entities, [])).toBe(entities);
    });

    it('drops entities owned by hidden accounts', async () => {
        const store = await importFreshStore();
        expect(store.filterOutHiddenAccounts(entities, ['user-b'])).toEqual([
            { _id: '1', userId: 'user-a' },
            { _id: '3', userId: 'user-a' },
        ]);
    });

    it('ignores hidden ids that own no entities (e.g. a signed-out account left in storage)', async () => {
        const store = await importFreshStore();
        expect(store.filterOutHiddenAccounts(entities, ['user-z'])).toEqual(entities);
    });

    it('can hide every account, yielding an empty list', async () => {
        const store = await importFreshStore();
        expect(store.filterOutHiddenAccounts(entities, ['user-a', 'user-b'])).toEqual([]);
    });
});
