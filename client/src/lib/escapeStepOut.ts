/**
 * Escape steps out one level at a time: the first Escape in a text field only leaves the field —
 * focus parks on the field's box, so `g`-jumps, row letters and F6 work again at once, and Enter
 * steps back in — and the next Escape is the page's (closing an editor page, stepping past a
 * review item). Pure so the guard matrix is unit-testable.
 */

export interface EscapeKeyEvent {
    key: string;
    defaultPrevented: boolean;
    isComposing: boolean;
}

export interface EscapeContext {
    /** The keydown came from a text-entry surface (`isEditableEventTarget`). */
    isEditableTarget: boolean;
    /** An open modal popup — its own Escape closes it, so nothing else may act. */
    isModalOpen: boolean;
}

/** Whether this keydown should take focus out of the text field it came from. */
export function shouldStepOutOfField(event: EscapeKeyEvent, context: EscapeContext): boolean {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) {
        return false;
    }
    return context.isEditableTarget && !context.isModalOpen;
}

/**
 * Decides whether a page-level Escape keydown should navigate back. Stands down when the event was
 * already claimed (`defaultPrevented` — an open Autocomplete popup, the notes editor's
 * ESC-to-preview), when it's an IME composition cancel, when any modal popup is open (Select
 * popups and inner Dialogs — their own ESC handling must win; see `isModalOpen`), and when it came
 * from a text field: that Escape only steps out of the field (`useEscapeStepsOutOfFields`).
 */
export function shouldHandlePageEscape(event: { defaultPrevented: boolean; isComposing: boolean }, context: EscapeContext): boolean {
    return !event.defaultPrevented && !event.isComposing && !context.isModalOpen && !context.isEditableTarget;
}

export interface EnterKeyEvent {
    key: string;
    defaultPrevented: boolean;
    isComposing: boolean;
    altKey: boolean;
    shiftKey: boolean;
    metaKey: boolean;
    ctrlKey: boolean;
}

export interface ParkedFieldContext {
    /** Focus sits on a field box that an Escape parked it on (`FIELD_PARKING_ATTR`). */
    isParkedOnField: boolean;
    isModalOpen: boolean;
}

/** Whether a bare Enter should put focus back into the parked field — modified Enters stay chords (Cmd/Ctrl+Enter saves). */
export function shouldStepIntoField(event: EnterKeyEvent, context: ParkedFieldContext): boolean {
    if (event.key !== 'Enter' || event.defaultPrevented || event.isComposing) {
        return false;
    }
    if (event.altKey || event.shiftKey || event.metaKey || event.ctrlKey) {
        return false;
    }
    return context.isParkedOnField && !context.isModalOpen;
}
