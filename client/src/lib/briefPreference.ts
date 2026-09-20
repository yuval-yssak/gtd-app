import { useSyncExternalStore } from 'react';

/**
 * Device-local "show briefs" preference: whether the weekly review renders an item's brief in
 * place of its notes preview. Same storage pattern as `colorTheme.ts`; storage access is wrapped
 * because localStorage can throw (private mode, blocked site data) and the review must still open.
 */
export const SHOW_BRIEFS_KEY = 'gtd:showBriefs';
const DEFAULT_SHOW_BRIEFS = true;

export function getShowBriefs(): boolean {
    try {
        const stored = localStorage.getItem(SHOW_BRIEFS_KEY);
        return stored === null ? DEFAULT_SHOW_BRIEFS : stored === 'true';
    } catch {
        return DEFAULT_SHOW_BRIEFS;
    }
}

export function setShowBriefs(isShown: boolean): void {
    const value = String(isShown);
    try {
        localStorage.setItem(SHOW_BRIEFS_KEY, value);
    } catch {
        // Storage unavailable — the in-tab listeners below still see the new value for this session.
    }
    // The native `storage` event only fires in OTHER tabs; dispatch one so this tab's hooks react.
    window.dispatchEvent(new StorageEvent('storage', { key: SHOW_BRIEFS_KEY, newValue: value }));
}

function subscribe(onChange: () => void): () => void {
    const onStorage = (event: StorageEvent) => {
        if (event.key === SHOW_BRIEFS_KEY) {
            onChange();
        }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
}

/** Reactively reads the preference and re-renders on changes from any tab. */
export function useShowBriefs(): boolean {
    return useSyncExternalStore(subscribe, getShowBriefs, () => DEFAULT_SHOW_BRIEFS);
}
