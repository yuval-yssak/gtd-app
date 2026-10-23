/**
 * Keyboard chords rendered the way the user's platform spells them: a Mac has no Alt, Home, End,
 * PageUp or PageDown keys (⌥ is Alt; Fn+arrows stand in for the rest), so every chord the app
 * teaches is built from arrows and the modifiers both keyboards have, and only its LABEL differs.
 */

export type ChordPart = 'alt' | 'shift' | 'up' | 'down' | 'left' | 'right' | 'space' | 'enter' | 'esc' | 'tab' | 'home' | 'end' | 'pageUp' | 'pageDown';

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
};

/** "⌥⇧↑" on a Mac, "Alt+Shift+↑" elsewhere. */
export function chordLabel(parts: readonly ChordPart[], isApple: boolean = isApplePlatform()): string {
    return isApple ? parts.map((part) => APPLE_GLYPHS[part]).join('') : parts.map((part) => PC_LABELS[part]).join('+');
}

/** Chords that do the same thing, side by side: "↑ / ↓". */
export function chordList(chords: ReadonlyArray<readonly ChordPart[]>, isApple: boolean = isApplePlatform()): string {
    return chords.map((chord) => chordLabel(chord, isApple)).join(' / ');
}
