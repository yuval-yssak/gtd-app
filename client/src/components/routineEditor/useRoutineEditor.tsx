import type { IDBPDatabase } from 'idb';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { CLARIFY_MODE_KEY, type InlineClarifyMode, parseClarifyMode } from '../../lib/clarifyMode';
import { isNewTabClick, type ModifierClickSource, useNewTabAwareNavigate } from '../../lib/newTabNavigation';
import type { MyDB, StoredPerson, StoredRoutine, StoredWorkContext } from '../../types/MyDB';
import { RoutineDialog } from '../routines/RoutineDialog';
import { RoutineEditorExpand } from './RoutineEditorExpand';
import { RoutineEditorPopover } from './RoutineEditorPopover';

interface UseRoutineEditorOptions {
    db: IDBPDatabase<MyDB>;
    /** Default-owner userId for new routines. The active session's account.id. */
    userId: string;
    people: StoredPerson[];
    workContexts: StoredWorkContext[];
    refreshRoutines: () => Promise<void>;
    refreshItems: () => Promise<void>;
    /** Mobile collapses expand/popover to dialog (anchors and inline forms misbehave on touch). */
    isMobile?: boolean;
}

export interface OpenRoutineEditorArgs {
    /** Omit to open the editor for creating a new routine. */
    routine?: StoredRoutine;
    /** Required for popover mode — without an anchor we fall through to dialog. */
    anchor?: HTMLElement;
    /** Pass the triggering mouse event so cmd/ctrl+click opens the routine page in a new tab. */
    event?: ModifierClickSource;
}

export interface RoutineEditorAPI {
    openEditor: (args: OpenRoutineEditorArgs) => void;
    /** Page renders this anywhere at root — emits the dialog or popover when applicable. */
    renderGlobal: () => ReactNode;
    /** Page renders this inside each row — emits the inline expand body when this row is open. */
    renderExpandFor: (routineId: string) => ReactNode;
}

type EditorState =
    | { kind: 'closed' }
    | { kind: 'dialog'; routine: StoredRoutine | undefined }
    | { kind: 'popover'; routine: StoredRoutine; anchor: HTMLElement }
    | { kind: 'expand'; routine: StoredRoutine };

/**
 * Resolves the effective variant for a given clarifyMode + open args. Mirrors `resolveVariant`
 * in `useItemEditor`.
 *
 * Differences from the item editor:
 * - `instant` falls back to dialog: routines always require a frequency + title, so there's no
 *   one-click instant flow.
 * - Creating a new routine (`args.routine === undefined`) always uses the dialog, regardless of
 *   the current mode — expand/popover make no sense without a row to anchor to.
 */
export function resolveRoutineVariant(
    mode: InlineClarifyMode,
    args: OpenRoutineEditorArgs,
    isMobile: boolean,
): { kind: 'state'; state: EditorState } | { kind: 'page'; routine: StoredRoutine } | { kind: 'newTab'; routine: StoredRoutine } {
    if (!args.routine) {
        return { kind: 'state', state: { kind: 'dialog', routine: undefined } };
    }
    // A modified click wins over every clarify mode — but only existing routines have a page,
    // so the new-routine gesture above still falls through to the create dialog.
    if (args.event && isNewTabClick(args.event)) {
        return { kind: 'newTab', routine: args.routine };
    }
    if (mode === 'page') {
        return { kind: 'page', routine: args.routine };
    }
    if (mode === 'expand' && !isMobile) {
        return { kind: 'state', state: { kind: 'expand', routine: args.routine } };
    }
    if (mode === 'popover' && !isMobile && args.anchor) {
        return { kind: 'state', state: { kind: 'popover', routine: args.routine, anchor: args.anchor } };
    }
    // dialog fall-through (default + mobile + popover-without-anchor + instant-on-routines)
    return { kind: 'state', state: { kind: 'dialog', routine: args.routine } };
}

/**
 * Host hook for the unified routine editor. Owns variant resolution and open state. Pages call
 * `openEditor` from row clicks / new-routine button and mount `renderGlobal()` at root +
 * `renderExpandFor(routine._id)` inside each row.
 */
export function useRoutineEditor({
    db,
    userId,
    people,
    workContexts,
    refreshRoutines,
    refreshItems,
    isMobile = false,
}: UseRoutineEditorOptions): RoutineEditorAPI {
    const navigateOrNewTab = useNewTabAwareNavigate();
    const [state, setState] = useState<EditorState>({ kind: 'closed' });
    const [, setClarifyMode] = useState<InlineClarifyMode>(() => parseClarifyMode(localStorage.getItem(CLARIFY_MODE_KEY)));

    useEffect(() => {
        function onStorage(e: StorageEvent) {
            if (e.key === CLARIFY_MODE_KEY) {
                setClarifyMode(parseClarifyMode(e.newValue));
            }
        }
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);

    const close = useCallback(() => setState({ kind: 'closed' }), []);

    const onSaved = useCallback(async () => {
        await refreshRoutines();
        await refreshItems();
    }, [refreshRoutines, refreshItems]);

    function openEditor(args: OpenRoutineEditorArgs) {
        const mode = parseClarifyMode(localStorage.getItem(CLARIFY_MODE_KEY));
        const resolved = resolveRoutineVariant(mode, args, isMobile);
        if (resolved.kind === 'newTab' || resolved.kind === 'page') {
            // 'page' passes undefined so the plain page-mode click always stays in-tab.
            navigateOrNewTab(resolved.kind === 'newTab' ? args.event : undefined, {
                to: '/routine/$routineId',
                params: { routineId: resolved.routine._id },
            });
            return;
        }
        setState(resolved.state);
    }

    const renderGlobal = useCallback((): ReactNode => {
        if (state.kind === 'dialog') {
            return (
                <RoutineDialog
                    db={db}
                    userId={userId}
                    workContexts={workContexts}
                    people={people}
                    {...(state.routine !== undefined ? { routine: state.routine } : {})}
                    onClose={close}
                    onSaved={onSaved}
                />
            );
        }
        if (state.kind === 'popover') {
            return (
                <RoutineEditorPopover
                    key={state.routine._id}
                    anchorEl={state.anchor}
                    db={db}
                    userId={userId}
                    workContexts={workContexts}
                    people={people}
                    routine={state.routine}
                    onClose={close}
                    onSaved={onSaved}
                />
            );
        }
        return null;
    }, [state, db, userId, people, workContexts, close, onSaved]);

    const renderExpandFor = useCallback(
        (routineId: string): ReactNode => {
            if (state.kind !== 'expand' || state.routine._id !== routineId) {
                return null;
            }
            return (
                <RoutineEditorExpand
                    key={state.routine._id}
                    db={db}
                    userId={userId}
                    workContexts={workContexts}
                    people={people}
                    routine={state.routine}
                    onClose={close}
                    onSaved={onSaved}
                />
            );
        },
        [state, db, userId, people, workContexts, close, onSaved],
    );

    return {
        openEditor,
        renderGlobal,
        renderExpandFor,
    };
}
