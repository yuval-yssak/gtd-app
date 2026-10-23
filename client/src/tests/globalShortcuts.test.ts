import { describe, expect, it } from 'vitest';
import {
    type GlobalKeyContext,
    type GlobalKeyEvent,
    GO_TO_LEADER_TIMEOUT_MS,
    GO_TO_TARGETS,
    leaderRemainingMs,
    resolveGlobalKey,
    shortcutKeyOf,
} from '../lib/globalShortcuts';

const key = (k: string, mods: Partial<GlobalKeyEvent> = {}): GlobalKeyEvent => ({
    key: k,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    repeat: false,
    isComposing: false,
    ...mods,
});
const at = (nowMs: number, overrides: Partial<GlobalKeyContext> = {}): GlobalKeyContext => ({
    isEditableTarget: false,
    isModalOpen: false,
    nowMs,
    ...overrides,
});

describe('resolveGlobalKey — g jumps', () => {
    it('g then a letter jumps to its page; the leader is consumed', () => {
        const started = resolveGlobalKey(null, key('g'), at(1000));
        expect(started).toEqual({ leader: 1000, action: { type: 'leaderStarted' } });
        const jumped = resolveGlobalKey(started.leader, key('n'), at(1200));
        expect(jumped.leader).toBeNull();
        expect(jumped.action).toEqual({ type: 'goTo', target: { key: 'n', to: '/next-actions', label: 'Next Actions' } });
    });

    it('AltGr on its way to a chord does not cancel a pending g', () => {
        expect(resolveGlobalKey(1000, key('AltGraph'), at(1100))).toEqual({ leader: 1000, action: null });
    });

    it('a bare modifier keydown after g keeps the leader waiting; g then ? shows the full list', () => {
        expect(resolveGlobalKey(1000, key('Shift', { shiftKey: true }), at(1100))).toEqual({ leader: 1000, action: null });
        expect(resolveGlobalKey(1000, key('?', { shiftKey: true }), at(1100))).toEqual({ leader: null, action: { type: 'showShortcuts' } });
    });

    it('an unknown second key cancels; a second key after the timeout is just a key again', () => {
        expect(resolveGlobalKey(1000, key('q'), at(1100))).toEqual({ leader: null, action: { type: 'leaderCancelled' } });
        expect(resolveGlobalKey(1000, key('n'), at(1000 + GO_TO_LEADER_TIMEOUT_MS + 1))).toEqual({ leader: null, action: null });
    });

    it('stands down in text fields, under modals, with modifiers (Shift+G included), on key repeat and during composition', () => {
        for (const step of [
            resolveGlobalKey(null, key('g'), at(0, { isEditableTarget: true })),
            resolveGlobalKey(null, key('g'), at(0, { isModalOpen: true })),
            resolveGlobalKey(null, key('g', { metaKey: true }), at(0)),
            resolveGlobalKey(null, key('g', { altKey: true }), at(0)),
            resolveGlobalKey(null, key('g', { shiftKey: true }), at(0)),
            resolveGlobalKey(null, key('g', { repeat: true }), at(0)),
            resolveGlobalKey(null, key('g', { isComposing: true }), at(0)),
        ]) {
            expect(step).toEqual({ leader: null, action: null });
        }
        // A pending leader is dropped when focus moved into a text field meanwhile.
        expect(resolveGlobalKey(1000, key('n'), at(1100, { isEditableTarget: true }))).toEqual({ leader: null, action: { type: 'leaderCancelled' } });
    });

    it('every jump key is unique and none collides with the leader itself', () => {
        const keys = GO_TO_TARGETS.map((target) => target.key);
        expect(new Set(keys).size).toBe(keys.length);
        expect(keys).not.toContain('g');
    });
});

describe('resolveGlobalKey — ?, / and F6', () => {
    it('? opens the legend and / focuses the list search, never from a text field', () => {
        expect(resolveGlobalKey(null, key('?', { shiftKey: true }), at(0)).action).toEqual({ type: 'showShortcuts' });
        expect(resolveGlobalKey(null, key('/'), at(0)).action).toEqual({ type: 'focusSearch' });
        expect(resolveGlobalKey(null, key('/'), at(0, { isEditableTarget: true })).action).toBeNull();
    });

    it('F6 cycles forward and Shift+F6 back — even from a text field, which is how a keyboard user leaves one', () => {
        expect(resolveGlobalKey(null, key('F6'), at(0, { isEditableTarget: true })).action).toEqual({ type: 'cycleRegion', delta: 1 });
        expect(resolveGlobalKey(1000, key('F6', { shiftKey: true }), at(1100))).toEqual({ leader: null, action: { type: 'cycleRegion', delta: -1 } });
        expect(resolveGlobalKey(null, key('F6', { metaKey: true }), at(0)).action).toBeNull();
    });

    it('F6 does nothing under an open dialog or menu: focus must not leave it for a region behind it', () => {
        expect(resolveGlobalKey(null, key('F6'), at(0, { isModalOpen: true }))).toEqual({ leader: null, action: null });
    });
});

describe('leaderRemainingMs', () => {
    it('counts down from the g press, not from the last keydown, and never goes negative', () => {
        expect(leaderRemainingMs(1000, 1000)).toBe(GO_TO_LEADER_TIMEOUT_MS);
        expect(leaderRemainingMs(1000, 2400)).toBe(GO_TO_LEADER_TIMEOUT_MS - 1400);
        expect(leaderRemainingMs(1000, 9000)).toBe(0);
    });
});

describe('shortcutKeyOf', () => {
    it('lowercases Latin letters (Caps Lock must not break g) and passes named keys through', () => {
        expect(shortcutKeyOf('G', 'KeyG', false)).toBe('g');
        expect(shortcutKeyOf('n', 'KeyN', false)).toBe('n');
        expect(shortcutKeyOf('F6', 'F6', false)).toBe('F6');
        expect(shortcutKeyOf('/', 'Slash', false)).toBe('/');
        // German "/" is Shift+7: printable ASCII from a non-letter key stays as typed.
        expect(shortcutKeyOf('/', 'Digit7', true)).toBe('/');
        expect(shortcutKeyOf('/', 'NumpadDivide', false)).toBe('/');
        expect(shortcutKeyOf('Dead', 'BracketLeft', false)).toBe('Dead');
        expect(shortcutKeyOf('Unidentified', '', false)).toBe('Unidentified');
    });

    it('punctuation that sits on a letter key keeps its meaning (AZERTY ? and , are on M; Dvorak , is on W)', () => {
        expect(shortcutKeyOf('?', 'KeyM', true)).toBe('?');
        expect(shortcutKeyOf(',', 'KeyM', false)).toBe(',');
        expect(shortcutKeyOf(',', 'KeyW', false)).toBe(',');
        // Dvorak's other letter-key punctuation is not a shortcut: it maps to the US letter (no shortcut is bound there).
        expect(shortcutKeyOf('.', 'KeyE', false)).toBe('e');
    });

    it('a non-Latin layout falls back to the key at the same physical position', () => {
        expect(shortcutKeyOf('ע', 'KeyG', false)).toBe('g');
        expect(shortcutKeyOf('מ', 'KeyN', false)).toBe('n');
        // Hebrew Q types "/" (printed on that key): it means "/".
        expect(shortcutKeyOf('/', 'KeyQ', false)).toBe('/');
        // Hebrew W types "'": not a shortcut symbol, so it is the W key — `g w` works.
        expect(shortcutKeyOf("'", 'KeyW', false)).toBe('w');
        expect(shortcutKeyOf('.', 'Slash', false)).toBe('.');
        // Any non-ASCII character on the Slash key (a layout that prints a letter there) falls back to "/" / "?".
        expect(shortcutKeyOf('ץ', 'Slash', false)).toBe('/');
        expect(shortcutKeyOf('ץ', 'Slash', true)).toBe('?');
        expect(shortcutKeyOf('ת', 'Comma', false)).toBe(',');
    });
});
