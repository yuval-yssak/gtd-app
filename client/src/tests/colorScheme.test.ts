// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    applyColorScheme,
    getColorSchemePreference,
    resolveColorScheme,
    setColorSchemePreference,
    startColorSchemeSync,
    subscribeColorSchemePreference,
} from '../lib/colorScheme';

const STORAGE_KEY = 'gtd:colorScheme';
const LEGACY_MUI_KEY = 'mui-mode';

/** A controllable `(prefers-color-scheme: dark)` query — jsdom ships no matchMedia. */
function installSystemScheme(initiallyDark: boolean) {
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    const query = {
        matches: initiallyDark,
        media: '(prefers-color-scheme: dark)',
        addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    };
    window.matchMedia = () => query as unknown as MediaQueryList;
    return {
        setDark(isDark: boolean) {
            query.matches = isDark;
            for (const listener of listeners) listener({ matches: isDark } as MediaQueryListEvent);
        },
        listenerCount: () => listeners.size,
    };
}

function stampedTheme() {
    return document.documentElement.getAttribute('data-theme');
}

beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
    localStorage.clear();
});

describe('getColorSchemePreference', () => {
    it('defaults to system when nothing is stored', () => {
        expect(getColorSchemePreference()).toBe('system');
    });

    it.each(['system', 'light', 'dark'] as const)('reads a stored "%s"', (preference) => {
        localStorage.setItem(STORAGE_KEY, preference);
        expect(getColorSchemePreference()).toBe(preference);
    });

    it('falls back to the choice MUI stored, so existing users keep their scheme', () => {
        localStorage.setItem(LEGACY_MUI_KEY, 'dark');
        expect(getColorSchemePreference()).toBe('dark');
    });

    it('prefers its own key over the MUI one', () => {
        localStorage.setItem(LEGACY_MUI_KEY, 'dark');
        localStorage.setItem(STORAGE_KEY, 'light');
        expect(getColorSchemePreference()).toBe('light');
    });

    it('ignores an unrecognised stored value', () => {
        localStorage.setItem(STORAGE_KEY, 'sepia');
        expect(getColorSchemePreference()).toBe('system');
    });
});

describe('resolveColorScheme', () => {
    it('follows the OS for system', () => {
        expect(resolveColorScheme('system', true)).toBe('dark');
        expect(resolveColorScheme('system', false)).toBe('light');
    });

    it('lets a manual choice win over the OS', () => {
        expect(resolveColorScheme('light', true)).toBe('light');
        expect(resolveColorScheme('dark', false)).toBe('dark');
    });
});

describe('applyColorScheme', () => {
    it('stamps data-theme on <html> from the preference and the OS', () => {
        installSystemScheme(true);
        applyColorScheme();
        expect(stampedTheme()).toBe('dark');

        localStorage.setItem(STORAGE_KEY, 'light');
        applyColorScheme();
        expect(stampedTheme()).toBe('light');
    });
});

describe('setColorSchemePreference', () => {
    it('persists, restamps, and notifies same-tab subscribers', () => {
        installSystemScheme(false);
        const seen: string[] = [];
        const unsubscribe = subscribeColorSchemePreference(() => seen.push(getColorSchemePreference()));

        setColorSchemePreference('dark');

        expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');
        expect(stampedTheme()).toBe('dark');
        expect(seen).toEqual(['dark']);
        unsubscribe();
    });
});

describe('startColorSchemeSync', () => {
    it('restamps when the OS scheme flips while the preference is system', () => {
        const system = installSystemScheme(false);
        const stop = startColorSchemeSync();
        expect(stampedTheme()).toBe('light');

        system.setDark(true);
        expect(stampedTheme()).toBe('dark');
        stop();
    });

    it('does not follow the OS when the user picked a scheme', () => {
        const system = installSystemScheme(false);
        localStorage.setItem(STORAGE_KEY, 'light');
        const stop = startColorSchemeSync();

        system.setDark(true);
        expect(stampedTheme()).toBe('light');
        stop();
    });

    it('restamps when another tab changes the preference', () => {
        installSystemScheme(false);
        const stop = startColorSchemeSync();

        localStorage.setItem(STORAGE_KEY, 'dark');
        window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: 'dark' }));
        expect(stampedTheme()).toBe('dark');
        stop();
    });

    it('adopts the MUI-era choice once, so later writes to the MUI key cannot change the preference', () => {
        installSystemScheme(true);
        localStorage.setItem(LEGACY_MUI_KEY, 'system');
        const stop = startColorSchemeSync();
        expect(localStorage.getItem(STORAGE_KEY)).toBe('system');

        // Anything left in or written to the MUI key after adoption is ignored.
        localStorage.setItem(LEGACY_MUI_KEY, 'dark');
        expect(getColorSchemePreference()).toBe('system');
        stop();
    });

    it('records "system" when there is no earlier choice at all', () => {
        installSystemScheme(false);
        const stop = startColorSchemeSync();
        expect(localStorage.getItem(STORAGE_KEY)).toBe('system');
        stop();
    });

    it('removes its listeners when stopped', () => {
        const system = installSystemScheme(false);
        const stop = startColorSchemeSync();
        stop();
        expect(system.listenerCount()).toBe(0);
    });
});
