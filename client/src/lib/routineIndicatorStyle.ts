import { useEffect, useState } from 'react';

export type RoutineIndicatorStyle = 'icon' | 'colorAccent' | 'chip' | 'none';

const STORAGE_KEY = 'gtd:routineIndicatorStyle';
const DEFAULT: RoutineIndicatorStyle = 'icon';

export function getRoutineIndicatorStyle(): RoutineIndicatorStyle {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'icon' || stored === 'colorAccent' || stored === 'chip' || stored === 'none') {
        return stored;
    }
    return DEFAULT;
}

export function setRoutineIndicatorStyle(style: RoutineIndicatorStyle): void {
    localStorage.setItem(STORAGE_KEY, style);
    // Dispatch a storage event so components in the same tab can react.
    // The native `storage` event only fires in *other* tabs, not the originating tab.
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: style }));
}

/** Reactively reads the routine indicator style and re-renders on changes from any tab. */
export function useRoutineIndicatorStyle(): RoutineIndicatorStyle {
    const [style, setStyle] = useState(getRoutineIndicatorStyle);

    useEffect(() => {
        function onStorage(e: StorageEvent) {
            if (e.key === STORAGE_KEY) {
                setStyle(getRoutineIndicatorStyle());
            }
        }
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);

    return style;
}
