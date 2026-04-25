import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadVisibleColumns, type SearchTableColumnId, saveVisibleColumns } from '../lib/searchTableColumns';

const STORAGE_KEY = 'gtd:searchTableColumns';

// Node environment has no localStorage — provide a minimal stub for these tests.
const store = new Map<string, string>();

const installStorage = () => {
    globalThis.localStorage = {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
            store.set(key, value);
        },
        removeItem: (key: string) => {
            store.delete(key);
        },
        clear: () => store.clear(),
        get length() {
            return store.size;
        },
        key: () => null,
    };
};

const writeRaw = (raw: string) => {
    localStorage.setItem(STORAGE_KEY, raw);
};

describe('loadVisibleColumns', () => {
    beforeEach(() => {
        store.clear();
        installStorage();
    });
    afterEach(() => {
        store.clear();
    });

    it('returns the default set when no value is stored', () => {
        const result = loadVisibleColumns();
        expect(result).toEqual(new Set<SearchTableColumnId>(['title', 'status', 'updated', 'expectedBy']));
    });

    it('falls back to defaults on corrupt JSON', () => {
        writeRaw('{not json');
        const result = loadVisibleColumns();
        expect(result.has('title')).toBe(true);
        expect(result.has('status')).toBe(true);
    });

    it('falls back to defaults when the stored value is not an array', () => {
        writeRaw(JSON.stringify({ foo: 'bar' }));
        const result = loadVisibleColumns();
        expect(result.has('title')).toBe(true);
    });

    it('always includes title even if absent from the stored array', () => {
        writeRaw(JSON.stringify(['status']));
        const result = loadVisibleColumns();
        expect(result.has('title')).toBe(true);
        expect(result.has('status')).toBe(true);
    });

    it('filters out unknown column ids', () => {
        writeRaw(JSON.stringify(['status', 'bogus', 42, 'people']));
        const result = loadVisibleColumns();
        expect(result.has('status')).toBe(true);
        expect(result.has('people')).toBe(true);
        // Cast to Set<string> to assert that the unknown value did not sneak past the type guard
        expect((result as Set<string>).has('bogus')).toBe(false);
    });
});

describe('saveVisibleColumns', () => {
    beforeEach(() => {
        store.clear();
        installStorage();
    });

    it('round-trips through loadVisibleColumns', () => {
        const original: ReadonlySet<SearchTableColumnId> = new Set<SearchTableColumnId>(['title', 'people', 'contexts']);
        saveVisibleColumns(original);
        const loaded = loadVisibleColumns();
        expect(loaded.has('title')).toBe(true);
        expect(loaded.has('people')).toBe(true);
        expect(loaded.has('contexts')).toBe(true);
        expect(loaded.has('status')).toBe(false);
    });
});
