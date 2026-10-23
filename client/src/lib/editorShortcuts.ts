import type { ClarifyDestination } from '../components/editItemDialogLogic';

/**
 * Keyboard shortcuts inside the item editor, as a pure resolver (unit-tested): Cmd/Ctrl+Enter
 * saves — from a text field too, it is how you finish typing; with focus OUTSIDE a text field, a
 * bare letter picks the status chip, and Alt(⌥)+↑/↓ / Alt+Shift+↑/↓ move the item in its list (the
 * same keys as on a list row). Letters never take a modifier (⌥+letter types an accented letter on
 * a Mac) and never act in a text field.
 */

export const STATUS_KEYS: ReadonlyArray<{ status: ClarifyDestination; key: string }> = [
    { status: 'inbox', key: 'i' },
    { status: 'nextAction', key: 'n' },
    { status: 'calendar', key: 'c' },
    { status: 'waitingFor', key: 'w' },
    { status: 'somedayMaybe', key: 's' },
    { status: 'routine', key: 'r' },
    { status: 'done', key: 'd' },
    { status: 'trash', key: 't' },
];

/** The letter that picks `status`'s chip (for its tooltip). */
export function statusKeyOf(status: ClarifyDestination): string | undefined {
    return STATUS_KEYS.find((entry) => entry.status === status)?.key;
}

export type PositionMove = 'top' | 'up' | 'down' | 'bottom';

export type EditorKeyAction = { type: 'save' } | { type: 'status'; status: ClarifyDestination } | { type: 'position'; move: PositionMove };

export interface EditorKeyChord {
    key: string;
    altKey: boolean;
    shiftKey: boolean;
    metaKey: boolean;
    ctrlKey: boolean;
    repeat: boolean;
}

const POSITION_KEYS: Record<string, { plain: PositionMove; withShift: PositionMove }> = {
    ArrowUp: { plain: 'up', withShift: 'top' },
    ArrowDown: { plain: 'down', withShift: 'bottom' },
};

export function resolveEditorKey(chord: EditorKeyChord, isEditableTarget: boolean): EditorKeyAction | null {
    if (chord.repeat) {
        return null;
    }
    if ((chord.metaKey || chord.ctrlKey) && chord.key === 'Enter') {
        return { type: 'save' };
    }
    if (isEditableTarget || chord.metaKey || chord.ctrlKey) {
        return null;
    }
    const position = POSITION_KEYS[chord.key];
    if (chord.altKey) {
        return position ? { type: 'position', move: chord.shiftKey ? position.withShift : position.plain } : null;
    }
    if (chord.shiftKey) {
        return null;
    }
    const entry = STATUS_KEYS.find((candidate) => candidate.key === chord.key.toLowerCase());
    return entry ? { type: 'status', status: entry.status } : null;
}
