import { useCallback, useState } from 'react';
import { FROM_GMAIL_READONLY_MESSAGE } from '../../db/itemMutations';
import { type ModifierClickSource, useNewTabAwareNavigate } from '../../lib/newTabNavigation';
import type { StoredItem } from '../../types/MyDB';
import type { EditableStatus } from '../editItemDialogLogic';

export interface OpenEditorArgs {
    item: StoredItem;
    /** When omitted, opens the editor with the item's current status as the active chip. */
    initialStatus?: EditableStatus | undefined;
    /** Pass the triggering mouse event so cmd/ctrl+click opens the item page in a new tab. */
    event?: ModifierClickSource | undefined;
}

export interface ItemEditorAPI {
    openEditor: (args: OpenEditorArgs) => void;
    /** Toast state for the fromGmail read-only notice. The hook owns it; the page mounts one toast driven by these. */
    toast: { open: boolean; message: string };
    closeToast: () => void;
    /**
     * Pre-wired callback that emits the canonical fromGmail-readonly toast. Route handlers pass
     * this into `clarifyToDone({ onReadOnlyGCal: editor.onFromGmailReadOnly })` so the message
     * string lives in exactly one place (the mutation module) and routes don't need to import it.
     */
    onFromGmailReadOnly: () => void;
}

/** Route target for an item's full-page editor. */
export function itemPageTargetFor(item: StoredItem, initialStatus: EditableStatus | undefined) {
    return { to: '/item/$itemId', params: { itemId: item._id }, search: { status: initialStatus ?? null } } as const;
}

/**
 * Host hook for opening the item editor from a list page. The editor is always the item page:
 * a plain click navigates in place, cmd/ctrl+click opens it in a new tab.
 */
export function useItemEditor(): ItemEditorAPI {
    const navigateOrNewTab = useNewTabAwareNavigate();
    const [toast, setToast] = useState<{ open: boolean; message: string }>({ open: false, message: '' });

    const openEditor = useCallback(
        ({ item, initialStatus, event }: OpenEditorArgs) => navigateOrNewTab(event, itemPageTargetFor(item, initialStatus)),
        [navigateOrNewTab],
    );
    // Stable handler so mutation call sites don't see a fresh function identity every render.
    const onFromGmailReadOnly = useCallback(() => setToast({ open: true, message: FROM_GMAIL_READONLY_MESSAGE }), []);
    const closeToast = useCallback(() => setToast({ open: false, message: '' }), []);

    return { openEditor, toast, closeToast, onFromGmailReadOnly };
}
