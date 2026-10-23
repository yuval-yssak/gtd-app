/**
 * Keyboard chords rendered the way the user's platform spells them: a Mac has no Alt, Home, End,
 * PageUp or PageDown keys (⌥ is Alt; Fn+arrows stand in for the rest), so every chord the app
 * teaches is built from arrows and the modifiers both keyboards have, and only its LABEL differs.
 */

export type ChordPart =
    | 'alt'
    | 'shift'
    | 'up'
    | 'down'
    | 'left'
    | 'right'
    | 'space'
    | 'enter'
    | 'esc'
    | 'tab'
    | 'home'
    | 'end'
    | 'pageUp'
    | 'pageDown'
    | 'f6'
    | 'mod';

/** macOS and iOS: ⌥ / ⇧ glyphs, and Cmd rather than Ctrl for the browser's own shortcuts. */
export function isApplePlatform(): boolean {
    return typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

const APPLE_GLYPHS: Record<ChordPart, string> = {
    alt: '⌥',
    shift: '⇧',
    up: '↑',
    down: '↓',
    left: '←',
    right: '→',
    space: 'Space',
    enter: '↩',
    esc: 'Esc',
    tab: 'Tab',
    home: 'Fn ←',
    end: 'Fn →',
    pageUp: 'Fn ↑',
    pageDown: 'Fn ↓',
    // Mac keyboards send the media key unless "Use F1, F2, etc. keys as standard function keys" is on.
    f6: 'Fn F6',
    // The platform's command key: ⌘ on a Mac, Ctrl elsewhere (Cmd/Ctrl+Enter saves the editor).
    mod: '⌘',
};

const PC_LABELS: Record<ChordPart, string> = {
    alt: 'Alt',
    shift: 'Shift',
    up: '↑',
    down: '↓',
    left: '←',
    right: '→',
    space: 'Space',
    enter: 'Enter',
    esc: 'Esc',
    tab: 'Tab',
    home: 'Home',
    end: 'End',
    pageUp: 'PgUp',
    pageDown: 'PgDn',
    f6: 'F6',
    mod: 'Ctrl',
};

/** "⌥⇧↑" on a Mac, "Alt+Shift+↑" elsewhere. */
export function chordLabel(parts: readonly ChordPart[], isApple: boolean = isApplePlatform()): string {
    return isApple ? parts.map((part) => APPLE_GLYPHS[part]).join('') : parts.map((part) => PC_LABELS[part]).join('+');
}

/** Chords that do the same thing, side by side: "↑ / ↓". */
export function chordList(chords: ReadonlyArray<readonly ChordPart[]>, isApple: boolean = isApplePlatform()): string {
    return chords.map((chord) => chordLabel(chord, isApple)).join(' / ');
}
