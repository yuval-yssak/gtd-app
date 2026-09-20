import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getShowBriefs, SHOW_BRIEFS_KEY, setShowBriefs } from '../lib/briefPreference';

// Node environment has no localStorage — provide a minimal stub (same shape as colorTheme.test.ts).
const store = new Map<string, string>();

function installLocalStorage(overrides: Partial<Storage> = {}) {
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
        ...overrides,
    } as Storage;
}

beforeEach(() => {
    store.clear();
    installLocalStorage();
    globalThis.window = globalThis.window ?? ({} as typeof globalThis.window);
    globalThis.window.dispatchEvent = vi.fn();
    const g = globalThis as Record<string, unknown>;
    // biome-ignore lint/complexity/useLiteralKeys: TS requires bracket notation for index signature
    if (typeof g['StorageEvent'] === 'undefined') {
        // biome-ignore lint/complexity/useLiteralKeys: TS requires bracket notation for index signature
        g['StorageEvent'] = class StorageEvent extends Event {
            key: string | null;
            newValue: string | null;
            constructor(type: string, init?: { key?: string; newValue?: string }) {
                super(type);
                this.key = init?.key ?? null;
                this.newValue = init?.newValue ?? null;
            }
        };
    }
});

afterEach(() => {
    store.clear();
});

describe('getShowBriefs', () => {
    it('defaults to true when nothing is stored', () => {
        expect(getShowBriefs()).toBe(true);
    });

    it('reads a stored false / true', () => {
        store.set(SHOW_BRIEFS_KEY, 'false');
        expect(getShowBriefs()).toBe(false);
        store.set(SHOW_BRIEFS_KEY, 'true');
        expect(getShowBriefs()).toBe(true);
    });

    it('treats an unrecognised stored value as off (only the literal "true" turns briefs on)', () => {
        store.set(SHOW_BRIEFS_KEY, 'yes');
        expect(getShowBriefs()).toBe(false);
    });

    it('falls back to the default when storage throws (private mode, blocked site data)', () => {
        installLocalStorage({
            getItem: () => {
                throw new Error('SecurityError');
            },
        });
        expect(getShowBriefs()).toBe(true);
    });
});

describe('setShowBriefs', () => {
    it('persists the value and round-trips through getShowBriefs', () => {
        setShowBriefs(false);
        expect(store.get(SHOW_BRIEFS_KEY)).toBe('false');
        expect(getShowBriefs()).toBe(false);
        setShowBriefs(true);
        expect(getShowBriefs()).toBe(true);
    });

    it('dispatches a same-tab StorageEvent so hooks re-read the preference', () => {
        setShowBriefs(false);
        expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ key: SHOW_BRIEFS_KEY, newValue: 'false' }));
    });

    it('still dispatches when storage throws, so this tab reflects the toggle for the session', () => {
        installLocalStorage({
            setItem: () => {
                throw new Error('QuotaExceededError');
            },
        });
        expect(() => setShowBriefs(false)).not.toThrow();
        expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ key: SHOW_BRIEFS_KEY, newValue: 'false' }));
    });
});
