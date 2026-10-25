import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ClarifyDestination } from '../components/itemEditor/itemEditorLogic';
import { isEditableEventTarget } from '../components/quickCapture/quickCaptureLogic';
import { type EditorKeyAction, type PositionMove, resolveEditorKey } from '../lib/editorShortcuts';

/**
 * Marks the editor root, which takes focus on a click into its empty space so its shortcuts keep
 * working. That focus is "parked", not a control: focus-restore logic must ignore it.
 */
export const EDITOR_KEY_SCOPE_ATTR = 'data-editor-key-scope';

/** True when focus sits on an editor root itself (parked by a click into empty space), not on a control in it. */
export function isParkedEditorFocus(target: Pick<Element, 'hasAttribute'> | null): boolean {
    return target?.hasAttribute(EDITOR_KEY_SCOPE_ATTR) ?? false;
}

/** Marks the editor's Position buttons, so Alt(⌥)+arrows press the right one (only while it is enabled). */
export const POSITION_MOVE_ATTR = 'data-position-move';

interface UseEditorShortcutsOptions {
    /** The editor's explicit save — skipped while the save button is disabled. */
    onSave: () => void;
    isSaveDisabled: boolean;
    /** Picks a status chip; `canPick` filters chips the editor does not offer (Routine on a non-inbox item). */
    onPickStatus: (status: ClarifyDestination) => void;
    canPick: (status: ClarifyDestination) => boolean;
}

function pressPositionButton(root: HTMLElement, move: PositionMove): boolean {
    const button = root.querySelector<HTMLElement>(`[${POSITION_MOVE_ATTR}="${move}"]:not([disabled])`);
    button?.click();
    return button !== null;
}

/** Performs a resolved key; returns whether it acted (only then is the key stopped). Exhaustive over the action union. */
function performEditorKey(action: EditorKeyAction, root: HTMLElement, options: UseEditorShortcutsOptions): boolean {
    switch (action.type) {
        case 'save':
            if (options.isSaveDisabled) {
                return false;
            }
            options.onSave();
            return true;
        case 'status':
            if (!options.canPick(action.status)) {
                return false;
            }
            options.onPickStatus(action.status);
            return true;
        case 'position':
            return pressPositionButton(root, action.move);
    }
}

/**
 * True when the key comes from the editor's OWN DOM. React bubbles a keydown through portals along
 * the component tree, so an open Select menu (Calendar, account, person) or a nested dialog (Send
 * updates, Unsaved changes) would otherwise reach this handler: typing "w" to jump in a menu must
 * not switch the item to Waiting For, and "d" under a confirm dialog must not change what it commits.
 */
function isFromEditorDom(e: ReactKeyboardEvent<HTMLElement>): boolean {
    return e.target instanceof Node && e.currentTarget.contains(e.target);
}

/**
 * The item editor's key handler (spread its result as the editor root's `onKeyDown`): see
 * `lib/editorShortcuts.ts` for the keys. A handled key stops here — a status letter must not also
 * reach the list around an inline editor, nor quick capture's `c`. Not memoised: its inputs are the
 * editor's per-render closures.
 */
export function useEditorShortcuts(options: UseEditorShortcutsOptions) {
    return (e: ReactKeyboardEvent<HTMLElement>) => {
        if (!isFromEditorDom(e)) {
            return;
        }
        const action = resolveEditorKey(e, isEditableEventTarget(e.target));
        if (action && performEditorKey(action, e.currentTarget, options)) {
            e.preventDefault();
            e.stopPropagation();
        }
    };
}
