import { useCallback } from 'react';
import { type ModifierClickSource, useNewTabAwareNavigate } from '../../lib/newTabNavigation';
import type { StoredRoutine } from '../../types/MyDB';

export interface OpenRoutineEditorArgs {
    /** Omit to open the editor for creating a new routine. */
    routine?: StoredRoutine | undefined;
    /** Pass the triggering mouse event so cmd/ctrl+click opens the routine page in a new tab. */
    event?: ModifierClickSource | undefined;
}

/** Route target for the routine editor page — the create page when no routine is given. */
export function routinePageTargetFor(routine: StoredRoutine | undefined) {
    if (!routine) {
        return { to: '/routine/new' } as const;
    }
    return { to: '/routine/$routineId', params: { routineId: routine._id } } as const;
}

/**
 * Host hook for opening the routine editor from a list page. The editor is always a page:
 * `/routine/new` to create, `/routine/:id` to edit; cmd/ctrl+click opens it in a new tab.
 */
export function useRoutineEditor() {
    const navigateOrNewTab = useNewTabAwareNavigate();
    const openEditor = useCallback(({ routine, event }: OpenRoutineEditorArgs) => navigateOrNewTab(event, routinePageTargetFor(routine)), [navigateOrNewTab]);
    return { openEditor };
}
