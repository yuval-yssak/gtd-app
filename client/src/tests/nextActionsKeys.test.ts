import { describe, expect, it } from 'vitest';
import { type KeyChord, PAGE_STEP, resolveGrabKey, resolveRowKey } from '../lib/nextActionsKeys';

const chord = (key: string, mods: Partial<KeyChord> = {}): KeyChord => ({
    key,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    repeat: false,
    ...mods,
});

describe('resolveGrabKey (a row is grabbed)', () => {
    it('arrows nudge one slot; Shift+arrow, Home and End jump to the section edges', () => {
        expect(resolveGrabKey(chord('ArrowUp'))).toEqual({ type: 'nudge', delta: -1 });
        expect(resolveGrabKey(chord('ArrowDown'))).toEqual({ type: 'nudge', delta: 1 });
        expect(resolveGrabKey(chord('ArrowUp', { shiftKey: true }))).toEqual({ type: 'jump', edge: 'top' });
        expect(resolveGrabKey(chord('ArrowDown', { shiftKey: true }))).toEqual({ type: 'jump', edge: 'bottom' });
        expect(resolveGrabKey(chord('Home'))).toEqual({ type: 'jump', edge: 'top' });
        expect(resolveGrabKey(chord('End'))).toEqual({ type: 'jump', edge: 'bottom' });
    });

    it('PageUp / PageDown move several slots; Space and Enter drop; Escape cancels', () => {
        expect(resolveGrabKey(chord('PageUp'))).toEqual({ type: 'nudge', delta: -PAGE_STEP });
        expect(resolveGrabKey(chord('PageDown'))).toEqual({ type: 'nudge', delta: PAGE_STEP });
        expect(resolveGrabKey(chord(' '))).toEqual({ type: 'drop' });
        expect(resolveGrabKey(chord('Enter'))).toEqual({ type: 'drop' });
        expect(resolveGrabKey(chord('Escape'))).toEqual({ type: 'cancel' });
        // A held Space must not drop and re-grab on every repeat.
        expect(resolveGrabKey(chord(' ', { repeat: true }))).toBeNull();
    });

    it('leaves Cmd/Ctrl/Alt chords to the browser (Cmd+arrows scroll the page, Cmd+←/→ navigate history)', () => {
        expect(resolveGrabKey(chord('ArrowUp', { metaKey: true }))).toBeNull();
        expect(resolveGrabKey(chord('ArrowDown', { ctrlKey: true }))).toBeNull();
        expect(resolveGrabKey(chord('ArrowDown', { altKey: true }))).toBeNull();
        expect(resolveGrabKey(chord('a'))).toBeNull();
    });
});

describe('resolveRowKey (a row is focused, nothing grabbed)', () => {
    it('Alt+arrow commits one slot, Alt+Shift+arrow and Alt+Home/End commit a jump; key repeat is ignored', () => {
        expect(resolveRowKey(chord('ArrowUp', { altKey: true }))).toEqual({ type: 'commitNudge', delta: -1 });
        expect(resolveRowKey(chord('ArrowDown', { altKey: true }))).toEqual({ type: 'commitNudge', delta: 1 });
        expect(resolveRowKey(chord('ArrowUp', { altKey: true, shiftKey: true }))).toEqual({ type: 'commitJump', edge: 'top' });
        expect(resolveRowKey(chord('ArrowDown', { altKey: true, shiftKey: true }))).toEqual({ type: 'commitJump', edge: 'bottom' });
        expect(resolveRowKey(chord('Home', { altKey: true }))).toEqual({ type: 'commitJump', edge: 'top' });
        expect(resolveRowKey(chord('End', { altKey: true }))).toEqual({ type: 'commitJump', edge: 'bottom' });
        expect(resolveRowKey(chord('ArrowUp', { altKey: true, repeat: true }))).toBeNull();
        expect(resolveRowKey(chord('ArrowUp', { altKey: true, shiftKey: true, repeat: true }))).toBeNull();
    });

    it('plain arrows, Home and End walk the list; Right enters the row actions; Space grabs', () => {
        expect(resolveRowKey(chord('ArrowUp'))).toEqual({ type: 'focusStep', delta: -1 });
        expect(resolveRowKey(chord('ArrowDown'))).toEqual({ type: 'focusStep', delta: 1 });
        expect(resolveRowKey(chord('Home'))).toEqual({ type: 'focusEdge', edge: 'top' });
        expect(resolveRowKey(chord('End'))).toEqual({ type: 'focusEdge', edge: 'bottom' });
        expect(resolveRowKey(chord('ArrowRight'))).toEqual({ type: 'enterActions' });
        expect(resolveRowKey(chord(' '))).toEqual({ type: 'grab' });
        // Enter is the row button's own activation (opens the editor) — not ours.
        expect(resolveRowKey(chord('Enter'))).toBeNull();
    });

    it('bare letters act on the row; the same letters with a modifier do nothing (⌥+e is a dead key on a Mac)', () => {
        expect(resolveRowKey(chord('e'))).toEqual({ type: 'rowAction', action: 'edit' });
        expect(resolveRowKey(chord('E'))).toEqual({ type: 'rowAction', action: 'edit' });
        expect(resolveRowKey(chord('d'))).toEqual({ type: 'rowAction', action: 'done' });
        expect(resolveRowKey(chord('c'))).toEqual({ type: 'rowAction', action: 'copyId' });
        expect(resolveRowKey(chord('m'))).toEqual({ type: 'rowAction', action: 'moveTo' });
        expect(resolveRowKey(chord('e', { altKey: true }))).toBeNull();
        expect(resolveRowKey(chord('e', { metaKey: true }))).toBeNull();
        expect(resolveRowKey(chord('c', { ctrlKey: true }))).toBeNull();
        expect(resolveRowKey(chord('ArrowDown', { shiftKey: true }))).toBeNull();
        expect(resolveRowKey(chord('x'))).toBeNull();
        // One-shot keys ignore key repeat (a held D must not mark the next row done); walking keys may repeat.
        expect(resolveRowKey(chord('d', { repeat: true }))).toBeNull();
        expect(resolveRowKey(chord(' ', { repeat: true }))).toBeNull();
        expect(resolveRowKey(chord('ArrowDown', { repeat: true }))).toEqual({ type: 'focusStep', delta: 1 });
    });
});
