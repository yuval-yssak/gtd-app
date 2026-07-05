import { useBlocker } from '@tanstack/react-router';
import { useRef, useState } from 'react';

export interface UnsavedChangesGuardOptions {
    /** Evaluated when an in-app navigation starts. Return true to pause it behind the confirm dialog. */
    hasUnsavedChanges: () => boolean;
    /**
     * Evaluated for the native beforeunload prompt (reload / tab close). Defaults to
     * `hasUnsavedChanges`. Pass a wider predicate when a hard unload would lose state that in-app
     * navigation would not — e.g. a debounced autosave commit whose unmount flush never runs on unload.
     */
    hasUnsavedChangesOnUnload?: () => boolean;
}

export interface UnsavedChangesBlocker {
    isBlocked: boolean;
    /** Cancel the navigation and keep the form as-is. */
    stay: () => void;
    /** Let the navigation through, discarding the unsaved edits. */
    discard: () => void;
}

/**
 * Pauses router navigations (and arms the native beforeunload prompt) while a form holds unsaved
 * changes. The predicates are re-read on every navigation attempt, so callers can pass plain
 * closures over the latest render — no memoization needed. Render an `UnsavedChangesDialog` from
 * the returned blocker to let the user choose between staying and discarding.
 */
export function useUnsavedChangesGuard({ hasUnsavedChanges, hasUnsavedChangesOnUnload }: UnsavedChangesGuardOptions): UnsavedChangesBlocker {
    const optionsRef = useRef({ hasUnsavedChanges, hasUnsavedChangesOnUnload });
    optionsRef.current = { hasUnsavedChanges, hasUnsavedChangesOnUnload };

    // Stable function identities: useBlocker re-registers its history block on every identity
    // change, so route the per-render predicates through the ref instead of passing them directly.
    const [stableOptions] = useState(() => ({
        shouldBlockFn: () => optionsRef.current.hasUnsavedChanges(),
        enableBeforeUnload: () => (optionsRef.current.hasUnsavedChangesOnUnload ?? optionsRef.current.hasUnsavedChanges)(),
    }));

    const resolver = useBlocker({ ...stableOptions, withResolver: true });
    return {
        isBlocked: resolver.status === 'blocked',
        stay: () => resolver.reset?.(),
        discard: () => resolver.proceed?.(),
    };
}
