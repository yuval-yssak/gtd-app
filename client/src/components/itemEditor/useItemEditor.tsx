import type { IDBPDatabase } from 'idb';
import { type ReactNode, useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { clarifyToNextAction, FROM_GMAIL_READONLY_MESSAGE } from '../../db/itemMutations';
import { CLARIFY_MODE_KEY, type InlineClarifyMode, parseClarifyMode } from '../../lib/clarifyMode';
import { isNewTabClick, type ModifierClickSource, useNewTabAwareNavigate } from '../../lib/newTabNavigation';
import type { MyDB, StoredItem, StoredPerson, StoredWorkContext } from '../../types/MyDB';
import { EditItemDialog } from '../EditItemDialog';
import type { EditableStatus } from '../editItemDialogLogic';
import { EditItemExpand } from './EditItemExpand';
import { EditItemPopover } from './EditItemPopover';

interface UseItemEditorOptions {
    db: IDBPDatabase<MyDB>;
    people: StoredPerson[];
    workContexts: StoredWorkContext[];
    refreshItems: () => Promise<void>;
    /** When true, mode='instant' fires the nextAction mutation directly. Inbox passes true; others false. */
    allowInstantNextAction?: boolean;
    /** Mobile collapses expand/popover to dialog (anchors and inline forms misbehave on touch). */
    isMobile?: boolean;
}

export interface OpenEditorArgs {
    item: StoredItem;
    /** When omitted, opens the editor with the item's current status as the active chip. */
    initialStatus?: EditableStatus;
    /** Required for popover mode — without an anchor we fall through to dialog. */
    anchor?: HTMLElement;
    /** Pass the triggering mouse event so cmd/ctrl+click opens the item page in a new tab. */
    event?: ModifierClickSource;
}

export interface ItemEditorAPI {
    openEditor: (args: OpenEditorArgs) => void;
    /** Page renders this anywhere at root — emits the dialog or popover when applicable. */
    renderGlobal: () => ReactNode;
    /** Page renders this inside each row — emits the inline expand body when this row is open. */
    renderExpandFor: (itemId: string) => ReactNode;
    /** True while an instant mutation is mid-flight — pages can disable rapid re-clicks if desired. */
    isMutating: boolean;
    /** Toast state for instant mode. The hook owns it; the page should mount one Snackbar driven by these. */
    instantToast: { open: boolean; message: string };
    closeInstantToast: () => void;
    /**
     * Pre-wired callback that emits the canonical fromGmail-readonly snackbar. Route handlers
     * pass this into `clarifyToDone({ onReadOnlyGCal: editor.onFromGmailReadOnly })` so the
     * message string lives in exactly one place (the mutation module) and routes don't need to
     * import it. Editor-internal save paths (dialog/popover/expand) consume the same handler
     * via the editor wrappers, so all surfaces share one source of truth.
     */
    onFromGmailReadOnly: () => void;
}

export type EditorState =
    | { kind: 'closed' }
    | { kind: 'dialog'; item: StoredItem; initialStatus: EditableStatus | undefined }
    | { kind: 'popover'; item: StoredItem; initialStatus: EditableStatus | undefined; anchor: HTMLElement }
    | { kind: 'expand'; item: StoredItem; initialStatus: EditableStatus | undefined };

/** Route target for an item's full-page editor — used by both the 'page' clarify mode and the new-tab gesture. */
function itemPageTargetFor(item: StoredItem, initialStatus: EditableStatus | undefined) {
    return { to: '/item/$itemId', params: { itemId: item._id }, search: { status: initialStatus ?? null } } as const;
}

/**
 * Resolves the effective variant for a given clarifyMode + open args. Centralised so all the
 * fall-through rules (mobile, missing anchor, instant-only-for-nextAction) live in one place.
 *
 * Returns a discriminated state OR a sentinel for instant — the caller dispatches accordingly.
 */
export function resolveVariant(
    mode: InlineClarifyMode,
    args: OpenEditorArgs,
    isMobile: boolean,
    allowInstantNextAction: boolean,
): { kind: 'state'; state: EditorState } | { kind: 'instant'; item: StoredItem } | { kind: 'page' } | { kind: 'newTab' } {
    // A modified click wins over every clarify mode — the user asked for a new tab, and in
    // particular the instant variant must not fire its irreversible mutation on that gesture.
    if (args.event && isNewTabClick(args.event)) {
        return { kind: 'newTab' };
    }
    if (mode === 'instant' && allowInstantNextAction && args.initialStatus === 'nextAction') {
        return { kind: 'instant', item: args.item };
    }
    if (mode === 'page') {
        return { kind: 'page' };
    }
    if (mode === 'expand' && !isMobile) {
        return { kind: 'state', state: { kind: 'expand', item: args.item, initialStatus: args.initialStatus } };
    }
    if (mode === 'popover' && !isMobile && args.anchor) {
        return { kind: 'state', state: { kind: 'popover', item: args.item, initialStatus: args.initialStatus, anchor: args.anchor } };
    }
    // dialog fall-through (default + mobile + popover-without-anchor + instant-with-required-fields)
    return { kind: 'state', state: { kind: 'dialog', item: args.item, initialStatus: args.initialStatus } };
}

/**
 * Host hook for the unified item editor. Owns variant resolution, open state, the instant-mode
 * mutation, and snackbar feedback. Pages call `openEditor` from row clicks / chip clicks and
 * mount `renderGlobal()` at root + `renderExpandFor(item._id)` inside each row.
 */
export function useItemEditor({
    db,
    people,
    workContexts,
    refreshItems,
    allowInstantNextAction = false,
    isMobile = false,
}: UseItemEditorOptions): ItemEditorAPI {
    const navigateOrNewTab = useNewTabAwareNavigate();
    const [state, setState] = useState<EditorState>({ kind: 'closed' });
    const [, setClarifyMode] = useState<InlineClarifyMode>(() => parseClarifyMode(localStorage.getItem(CLARIFY_MODE_KEY)));
    const [isMutating, startMutation] = useTransition();
    // useTransition does not dedupe successive startTransition calls — a rapid double-click would
    // queue two mutations. The ref short-circuits the second one.
    const isMutatingRef = useRef(false);
    const [instantToast, setInstantToast] = useState<{ open: boolean; message: string }>({ open: false, message: '' });

    // Listen for settings-page changes via the `storage` event. The settings page dispatches the
    // event manually (storage events fire only in OTHER tabs by default), so this re-renders the
    // hook's host page and the next openEditor call reads the fresh mode from localStorage.
    useEffect(() => {
        function onStorage(e: StorageEvent) {
            if (e.key === CLARIFY_MODE_KEY) {
                setClarifyMode(parseClarifyMode(e.newValue));
            }
        }
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);

    // Stable reference so the renderGlobal/renderExpandFor useCallbacks don't churn on every render.
    const close = useCallback(() => setState({ kind: 'closed' }), []);

    function fireInstantNextAction(item: StoredItem) {
        if (isMutatingRef.current) {
            return;
        }
        isMutatingRef.current = true;
        startMutation(async () => {
            try {
                await clarifyToNextAction(db, item, {});
                await refreshItems();
                // Toast only after the mutation persists — a rejected write should not show
                // "Moved to Next Actions" to the user.
                setInstantToast({ open: true, message: 'Moved to Next Actions' });
            } finally {
                isMutatingRef.current = false;
            }
        });
    }

    function openEditor(args: OpenEditorArgs) {
        // Read mode at click time — picks up settings changes between component renders without
        // needing a reactive subscription past the storage listener above.
        const mode = parseClarifyMode(localStorage.getItem(CLARIFY_MODE_KEY));
        const resolved = resolveVariant(mode, args, isMobile, allowInstantNextAction);
        if (resolved.kind === 'instant') {
            fireInstantNextAction(resolved.item);
            return;
        }
        if (resolved.kind === 'newTab' || resolved.kind === 'page') {
            // 'page' passes undefined so the plain page-mode click always stays in-tab.
            navigateOrNewTab(resolved.kind === 'newTab' ? args.event : undefined, itemPageTargetFor(args.item, args.initialStatus));
            return;
        }
        setState(resolved.state);
    }

    // Stable handler so editor wrappers don't see a fresh function identity every render.
    const onFromGmailReadOnly = useCallback(() => setInstantToast({ open: true, message: FROM_GMAIL_READONLY_MESSAGE }), []);

    const renderGlobal = useCallback((): ReactNode => {
        if (state.kind === 'dialog') {
            // initialStatus is part of the key so a chip click on an already-open editor (same
            // item, new initialStatus) forces a remount and re-seeds the local status state —
            // otherwise the chip click silently no-ops because useState seeds from initialStatus
            // only on first render.
            return (
                <EditItemDialog
                    key={`${state.item._id}:${state.initialStatus ?? ''}`}
                    item={state.item}
                    db={db}
                    people={people}
                    workContexts={workContexts}
                    onClose={close}
                    onSaved={refreshItems}
                    onFromGmailReadOnly={onFromGmailReadOnly}
                    {...(state.initialStatus ? { initialStatus: state.initialStatus } : {})}
                />
            );
        }
        if (state.kind === 'popover') {
            return (
                <EditItemPopover
                    key={`${state.item._id}:${state.initialStatus ?? ''}`}
                    anchorEl={state.anchor}
                    item={state.item}
                    db={db}
                    people={people}
                    workContexts={workContexts}
                    onClose={close}
                    onSaved={refreshItems}
                    onFromGmailReadOnly={onFromGmailReadOnly}
                    {...(state.initialStatus ? { initialStatus: state.initialStatus } : {})}
                />
            );
        }
        return null;
    }, [state, db, people, workContexts, refreshItems, close, onFromGmailReadOnly]);

    const renderExpandFor = useCallback(
        (itemId: string): ReactNode => {
            if (state.kind !== 'expand' || state.item._id !== itemId) {
                return null;
            }
            return (
                <EditItemExpand
                    key={`${state.item._id}:${state.initialStatus ?? ''}`}
                    item={state.item}
                    db={db}
                    people={people}
                    workContexts={workContexts}
                    onClose={close}
                    onSaved={refreshItems}
                    onFromGmailReadOnly={onFromGmailReadOnly}
                    {...(state.initialStatus ? { initialStatus: state.initialStatus } : {})}
                />
            );
        },
        [state, db, people, workContexts, refreshItems, close, onFromGmailReadOnly],
    );

    return {
        openEditor,
        renderGlobal,
        renderExpandFor,
        isMutating,
        instantToast,
        closeInstantToast: () => setInstantToast({ open: false, message: '' }),
        onFromGmailReadOnly,
    };
}
