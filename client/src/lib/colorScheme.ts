import { useSyncExternalStore } from 'react';

export type ColorSchemePreference = 'system' | 'light' | 'dark';
export type ResolvedColorScheme = 'light' | 'dark';

const STORAGE_KEY = 'gtd:colorScheme';
// MUI's useColorScheme persisted the choice here; read it so the migration keeps every user's scheme.
const LEGACY_MUI_KEY = 'mui-mode';
const DARK_QUERY = '(prefers-color-scheme: dark)';
// Same-tab notification: the native `storage` event only fires in other tabs.
const LOCAL_CHANGE_EVENT = 'gtd:color-scheme-change';

const PREFERENCES: ReadonlySet<string> = new Set<ColorSchemePreference>(['system', 'light', 'dark']);

function isColorSchemePreference(value: string | null): value is ColorSchemePreference {
    return value !== null && PREFERENCES.has(value);
}

export function getColorSchemePreference(): ColorSchemePreference {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isColorSchemePreference(stored)) return stored;
    const legacy = localStorage.getItem(LEGACY_MUI_KEY);
    return isColorSchemePreference(legacy) ? legacy : 'system';
}

export function resolveColorScheme(preference: ColorSchemePreference, systemPrefersDark: boolean): ResolvedColorScheme {
    if (preference !== 'system') return preference;
    return systemPrefersDark ? 'dark' : 'light';
}

function systemPrefersDark() {
    return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches;
}

/** Stamps `data-theme` on <html>; the tokens in designSystem/tokens/variables.css switch on it. */
export function applyColorScheme() {
    document.documentElement.setAttribute('data-theme', resolveColorScheme(getColorSchemePreference(), systemPrefersDark()));
}

export function setColorSchemePreference(preference: ColorSchemePreference) {
    localStorage.setItem(STORAGE_KEY, preference);
    applyColorScheme();
    window.dispatchEvent(new Event(LOCAL_CHANGE_EVENT));
}

/** Fires on a preference change from this tab or another one. */
export function subscribeColorSchemePreference(onChange: () => void) {
    function onStorage(event: StorageEvent) {
        if (event.key === STORAGE_KEY) onChange();
    }
    window.addEventListener('storage', onStorage);
    window.addEventListener(LOCAL_CHANGE_EVENT, onChange);
    return () => {
        window.removeEventListener('storage', onStorage);
        window.removeEventListener(LOCAL_CHANGE_EVENT, onChange);
    };
}

function subscribeSystemScheme(onChange: () => void) {
    if (typeof window.matchMedia !== 'function') return () => {};
    const query = window.matchMedia(DARK_QUERY);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
}

/**
 * Copies the MUI-era choice into our own key once. From then on MUI's key only mirrors the
 * resolved scheme (the bridge in __root writes "dark" for a system user on a dark OS), so it must
 * never be read as a preference again.
 */
function adoptLegacyPreference() {
    if (localStorage.getItem(STORAGE_KEY) !== null) return;
    localStorage.setItem(STORAGE_KEY, getColorSchemePreference());
}

/**
 * Keeps <html data-theme> current for the page's lifetime: stamps once, then restamps when the
 * OS scheme flips (only matters under "system") or another tab changes the preference.
 */
export function startColorSchemeSync() {
    adoptLegacyPreference();
    applyColorScheme();
    const stopSystem = subscribeSystemScheme(applyColorScheme);
    const stopPreference = subscribeColorSchemePreference(applyColorScheme);
    return () => {
        stopSystem();
        stopPreference();
    };
}

/** The stored preference, re-rendering on changes from any tab — for the Settings toggle. */
export function useColorSchemePreference() {
    return useSyncExternalStore(subscribeColorSchemePreference, getColorSchemePreference);
}

/** The scheme actually painted — for the few consumers that need it in JS rather than CSS. */
export function useResolvedColorScheme() {
    return useSyncExternalStore(subscribeResolved, getResolvedColorScheme);
}

function subscribeResolved(onChange: () => void) {
    const stopSystem = subscribeSystemScheme(onChange);
    const stopPreference = subscribeColorSchemePreference(onChange);
    return () => {
        stopSystem();
        stopPreference();
    };
}

function getResolvedColorScheme() {
    return resolveColorScheme(getColorSchemePreference(), systemPrefersDark());
}
