import { describe, expect, it } from 'vitest';
import { type EditorKeyChord, resolveEditorKey, STATUS_KEYS } from '../lib/editorShortcuts';

const chord = (key: string, mods: Partial<EditorKeyChord> = {}): EditorKeyChord => ({
    key,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    repeat: false,
    ...mods,
});

describe('resolveEditorKey', () => {
    it('Cmd/Ctrl+Enter saves, from a text field too; a repeat does not', () => {
        expect(resolveEditorKey(chord('Enter', { metaKey: true }), true)).toEqual({ type: 'save' });
        expect(resolveEditorKey(chord('Enter', { ctrlKey: true }), false)).toEqual({ type: 'save' });
        expect(resolveEditorKey(chord('Enter', { metaKey: true, repeat: true }), false)).toBeNull();
        expect(resolveEditorKey(chord('Enter'), false)).toBeNull();
    });

    it('a bare letter outside a text field picks its status chip; in a text field it is typing', () => {
        expect(resolveEditorKey(chord('n'), false)).toEqual({ type: 'status', status: 'nextAction' });
        expect(resolveEditorKey(chord('D'), false)).toEqual({ type: 'status', status: 'done' });
        expect(resolveEditorKey(chord('t'), false)).toEqual({ type: 'status', status: 'trash' });
        expect(resolveEditorKey(chord('n'), true)).toBeNull();
        expect(resolveEditorKey(chord('n', { altKey: true }), false)).toBeNull();
        expect(resolveEditorKey(chord('n', { metaKey: true }), false)).toBeNull();
        expect(resolveEditorKey(chord('N', { shiftKey: true }), false)).toBeNull();
        expect(resolveEditorKey(chord('x'), false)).toBeNull();
    });

    it('Alt+↑/↓ moves one slot, Alt+Shift+↑/↓ to the top/bottom — never from a text field (⌥↑ moves the caret there)', () => {
        expect(resolveEditorKey(chord('ArrowUp', { altKey: true }), false)).toEqual({ type: 'position', move: 'up' });
        expect(resolveEditorKey(chord('ArrowDown', { altKey: true }), false)).toEqual({ type: 'position', move: 'down' });
        expect(resolveEditorKey(chord('ArrowUp', { altKey: true, shiftKey: true }), false)).toEqual({ type: 'position', move: 'top' });
        expect(resolveEditorKey(chord('ArrowDown', { altKey: true, shiftKey: true }), false)).toEqual({ type: 'position', move: 'bottom' });
        expect(resolveEditorKey(chord('ArrowUp', { altKey: true }), true)).toBeNull();
        expect(resolveEditorKey(chord('ArrowUp'), false)).toBeNull();
    });

    it('every status letter is unique', () => {
        const keys = STATUS_KEYS.map((entry) => entry.key);
        expect(new Set(keys).size).toBe(keys.length);
    });
});
