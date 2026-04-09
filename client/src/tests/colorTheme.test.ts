import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildThemeOptions, getColorTheme, setColorTheme } from '../lib/colorTheme';

const STORAGE_KEY = 'gtd:colorTheme';

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

describe('getColorTheme', () => {
    it('returns "default" when nothing is stored', () => {
        expect(getColorTheme()).toBe('default');
    });

    it.each(['default', 'forest', 'ocean', 'ember', 'plum', 'slate', 'terracotta'] as const)('returns "%s" when stored', (id) => {
        store.set(STORAGE_KEY, id);
        expect(getColorTheme()).toBe(id);
    });

    it('returns "default" for an invalid stored value', () => {
        store.set(STORAGE_KEY, 'neon-pink');
        expect(getColorTheme()).toBe('default');
    });
});

describe('setColorTheme', () => {
    it('writes the theme id to localStorage', () => {
        setColorTheme('forest');
        expect(store.get(STORAGE_KEY)).toBe('forest');
    });

    it('dispatches a StorageEvent so same-tab listeners react', () => {
        setColorTheme('plum');
        expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ key: STORAGE_KEY, newValue: 'plum' }));
    });
});

describe('buildThemeOptions', () => {
    it('returns default MUI color schemes for "default" theme', () => {
        const opts = buildThemeOptions('default');
        expect(opts.colorSchemes).toEqual({ light: true, dark: true });
        expect(opts.colorSchemeSelector).toBe('[data-color-scheme="%s"]');
    });

    it('returns palette overrides for a custom theme', () => {
        const opts = buildThemeOptions('forest');
        expect(opts.colorSchemes).toEqual({
            light: { palette: { primary: { main: '#2e7d32' }, secondary: { main: '#8d6e63' } } },
            dark: { palette: { primary: { main: '#2e7d32' }, secondary: { main: '#8d6e63' } } },
        });
    });

    it('applies the same palette to both light and dark schemes', () => {
        const opts = buildThemeOptions('ember');
        const { light, dark } = opts.colorSchemes as { light: { palette: unknown }; dark: { palette: unknown } };
        expect(light.palette).toEqual(dark.palette);
    });
});
