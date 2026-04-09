import { useEffect, useState } from 'react';

export type ColorThemeId = 'default' | 'forest' | 'ocean' | 'ember' | 'plum' | 'slate' | 'terracotta';

export interface ColorThemeDef {
    id: ColorThemeId;
    label: string;
    primary: string;
    secondary: string;
}

const STORAGE_KEY = 'gtd:colorTheme';
const DEFAULT: ColorThemeId = 'default';

export const COLOR_THEMES: readonly ColorThemeDef[] = [
    { id: 'default', label: 'Default', primary: '#1976d2', secondary: '#9c27b0' },
    { id: 'forest', label: 'Forest Focus', primary: '#2e7d32', secondary: '#8d6e63' },
    { id: 'ocean', label: 'Deep Ocean', primary: '#1565c0', secondary: '#00838f' },
    { id: 'ember', label: 'Warm Ember', primary: '#e65100', secondary: '#4e342e' },
    { id: 'plum', label: 'Midnight Plum', primary: '#6a1b9a', secondary: '#00897b' },
    { id: 'slate', label: 'Slate Minimal', primary: '#455a64', secondary: '#ff8f00' },
    { id: 'terracotta', label: 'Terracotta', primary: '#bf360c', secondary: '#558b2f' },
];

const VALID_IDS: ReadonlySet<string> = new Set(COLOR_THEMES.map((t) => t.id));
const THEME_MAP = new Map(COLOR_THEMES.map((t) => [t.id, t]));

function isColorThemeId(value: string): value is ColorThemeId {
    return VALID_IDS.has(value);
}

export function getColorTheme(): ColorThemeId {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored !== null && isColorThemeId(stored)) {
        return stored;
    }
    return DEFAULT;
}

export function setColorTheme(id: ColorThemeId): void {
    localStorage.setItem(STORAGE_KEY, id);
    // Dispatch a storage event so components in the same tab can react.
    // The native `storage` event only fires in *other* tabs, not the originating tab.
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: id }));
}

/** Reactively reads the color theme and re-renders on changes from any tab. */
export function useColorTheme(): ColorThemeId {
    const [theme, setTheme] = useState(getColorTheme);

    useEffect(() => {
        function onStorage(e: StorageEvent) {
            if (e.key === STORAGE_KEY) {
                setTheme(getColorTheme());
            }
        }
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);

    return theme;
}

/** Builds MUI `extendTheme` options for the given color theme. */
export function buildThemeOptions(id: ColorThemeId) {
    const base = {
        colorSchemeSelector: '[data-color-scheme="%s"]' as const,
    };

    if (id === 'default') {
        return { ...base, colorSchemes: { light: true, dark: true } as const };
    }

    const def = THEME_MAP.get(id);
    if (!def) {
        return { ...base, colorSchemes: { light: true, dark: true } as const };
    }
    const palette = { primary: { main: def.primary }, secondary: { main: def.secondary } };

    return {
        ...base,
        colorSchemes: {
            light: { palette },
            dark: { palette },
        },
    };
}
