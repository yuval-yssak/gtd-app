export const QUICK_CAPTURE_SHORTCUT_KEY = 'c';

export interface CaptureShortcutEvent {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    defaultPrevented: boolean;
    isComposing: boolean;
}

export interface CaptureShortcutContext {
    /** An open MUI modal (dialog, drawer, popover) — the shortcut must not fire underneath it. */
    isModalOpen: boolean;
    /** The event target is a text-entry surface — typing "c" there is content, not a command. */
    isEditableTarget: boolean;
}

/**
 * Whether a keydown should open the global quick-capture dialog. Pure so the guard matrix is
 * unit-testable without DOM events; the hook derives `context` from the live document.
 */
export function shouldOpenQuickCapture(event: CaptureShortcutEvent, context: CaptureShortcutContext): boolean {
    if (event.key.toLowerCase() !== QUICK_CAPTURE_SHORTCUT_KEY) {
        return false;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) {
        return false;
    }
    if (event.defaultPrevented || event.isComposing) {
        return false;
    }
    return !context.isModalOpen && !context.isEditableTarget;
}

/** True for targets where a bare letter keystroke is text input rather than a shortcut. */
export function isEditableEventTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
        return false;
    }
    if (target.isContentEditable) {
        return true;
    }
    return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}
