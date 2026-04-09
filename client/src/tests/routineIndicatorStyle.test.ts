import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRoutineIndicatorStyle, setRoutineIndicatorStyle } from '../lib/routineIndicatorStyle';

const STORAGE_KEY = 'gtd:routineIndicatorStyle';

// Node environment has no localStorage — provide a minimal stub
const store = new Map<string, string>();

beforeEach(() => {
    store.clear();
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
    // setRoutineIndicatorStyle dispatches a StorageEvent on window
    globalThis.window = globalThis.window ?? ({} as typeof globalThis.window);
    if (!globalThis.window.dispatchEvent) {
        globalThis.window.dispatchEvent = vi.fn();
    }
    // Node has no StorageEvent constructor — bracket notation required by TS for index signature access
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

describe('getRoutineIndicatorStyle', () => {
    it('returns "icon" as the default when nothing is stored', () => {
        expect(getRoutineIndicatorStyle()).toBe('icon');
    });

    it.each(['icon', 'colorAccent', 'chip', 'none'] as const)('returns "%s" when stored', (style) => {
        store.set(STORAGE_KEY, style);
        expect(getRoutineIndicatorStyle()).toBe(style);
    });

    it('returns default for an invalid stored value', () => {
        store.set(STORAGE_KEY, 'invalid');
        expect(getRoutineIndicatorStyle()).toBe('icon');
    });
});

describe('setRoutineIndicatorStyle', () => {
    it('writes the style to localStorage', () => {
        setRoutineIndicatorStyle('chip');
        expect(store.get(STORAGE_KEY)).toBe('chip');
    });

    it('dispatches a StorageEvent so same-tab listeners react', () => {
        setRoutineIndicatorStyle('chip');
        expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ key: STORAGE_KEY, newValue: 'chip' }));
    });
});
