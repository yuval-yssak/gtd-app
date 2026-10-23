import type { FileRouteTypes } from '../routeTree.gen';

/**
 * Page-independent keyboard shortcuts, as a pure state machine so every guard is unit-testable:
 * `g` then a letter jumps to a page (Gmail style), `?` opens the shortcuts legend, `/` focuses the
 * list search, F6 / Shift+F6 cycle the keyboard regions. Letters are bare (never ⌥+letter, which
 * types an accented character on a Mac, nor Cmd/Ctrl+letter, which the browser owns).
 */

export interface GoToTarget {
    key: string;
    to: FileRouteTypes['to'];
    label: string;
}

/** The `g` jumps, in sidebar order. `x` is conteXts; `,` is Settings (the Mac preferences key). */
export const GO_TO_TARGETS: readonly GoToTarget[] = [
    { key: 'i', to: '/inbox', label: 'Inbox' },
    { key: 'n', to: '/next-actions', label: 'Next Actions' },
    { key: 'c', to: '/calendar', label: 'Calendar' },
    { key: 'w', to: '/waiting-for', label: 'Waiting For' },
    { key: 't', to: '/tickler', label: 'Tickler' },
    { key: 's', to: '/someday', label: 'Someday / Maybe' },
    { key: 'r', to: '/routines', label: 'Routines' },
    { key: 'p', to: '/people', label: 'People' },
    { key: 'x', to: '/work-contexts', label: 'Work Contexts' },
    { key: 'f', to: '/search', label: 'Search' },
    { key: 'v', to: '/weekly-review', label: 'Weekly Review' },
    { key: 'd', to: '/done', label: 'Done' },
    { key: ',', to: '/settings', label: 'Settings' },
];

/** How long after `g` the second key still counts as part of the jump. */
export const GO_TO_LEADER_TIMEOUT_MS = 1500;

/** Milliseconds left before a `g` pressed at `leaderMs` expires — the hint must vanish exactly when the jump stops working. */
export function leaderRemainingMs(leaderMs: number, nowMs: number): number {
    return Math.max(GO_TO_LEADER_TIMEOUT_MS - (nowMs - leaderMs), 0);
}

export interface GlobalKeyEvent {
    /** The layout-independent letter (see `shortcutKeyOf`), not the raw `event.key`. */
    key: string;
    altKey: boolean;
    shiftKey: boolean;
    metaKey: boolean;
    ctrlKey: boolean;
    repeat: boolean;
    isComposing: boolean;
}

export interface GlobalKeyContext {
    /** A text-entry surface has focus — letters there are content, not commands. */
    isEditableTarget: boolean;
    /** An open modal (dialog, drawer, menu) — no page shortcut may act underneath it, F6 included. */
    isModalOpen: boolean;
    nowMs: number;
}

/** `null` = idle; otherwise the time `g` was pressed. */
export type LeaderState = number | null;

export type GlobalKeyAction =
    | { type: 'leaderStarted' }
    | { type: 'leaderCancelled' }
    | { type: 'goTo'; target: GoToTarget }
    | { type: 'showShortcuts' }
    | { type: 'focusSearch' }
    | { type: 'cycleRegion'; delta: 1 | -1 };

export interface GlobalKeyStep {
    leader: LeaderState;
    action: GlobalKeyAction | null;
}

const IDLE: GlobalKeyStep = { leader: null, action: null };

/** A keydown of a modifier alone (on its way to a chord) changes nothing — not even a pending leader. */
const MODIFIER_KEYS = new Set(['Shift', 'Alt', 'AltGraph', 'Meta', 'Control', 'CapsLock']);

/** The punctuation that is itself a shortcut: typed, it means itself, wherever the layout put it (AZERTY `?` and `,` sit on the M key). */
const SHORTCUT_SYMBOLS = new Set(['/', '?', ',']);

/** US symbols by physical key, for a non-ASCII character typed on a symbol key. */
const CODE_KEYS: Record<string, string> = { Slash: '/', Comma: ',' };

/**
 * The key a shortcut matches, in this order:
 *  1. a Latin letter, lowercased (Caps Lock must not break `g`) — AZERTY and Dvorak keep their own letters;
 *  2. a shortcut symbol (`/ ? ,`) as typed, whichever key produced it (AZERTY `?` is Shift+M, Dvorak `,` is the W key);
 *  3. a letter KEY typing anything else (Hebrew `g` types `ע`, its W types `'`): the letter of its US position
 *     (`event.code`), so `g w` and `g n` work on Hebrew and Russian layouts;
 *  4. other printable ASCII as typed; a non-ASCII character on a symbol key falls back to its US symbol.
 * Named keys (`F6`, `Dead`, `Unidentified`) pass through unchanged.
 */
export function shortcutKeyOf(key: string, code: string, shiftKey: boolean): string {
    if (key.length !== 1) {
        return key;
    }
    if (/^[a-zA-Z]$/.test(key)) {
        return key.toLowerCase();
    }
    if (SHORTCUT_SYMBOLS.has(key)) {
        return key;
    }
    const letter = /^Key([A-Z])$/.exec(code)?.[1];
    if (letter) {
        return letter.toLowerCase();
    }
    if (/^[\x20-\x7e]$/.test(key)) {
        return key;
    }
    const symbol = CODE_KEYS[code];
    return symbol === '/' && shiftKey ? '?' : (symbol ?? key);
}

/**
 * One keydown through the machine. F6 works from text fields too (it is how a keyboard user
 * leaves one) but, like every shortcut, never underneath an open modal; letters also stand down
 * in text fields, with modifiers, on key repeat and during IME composition.
 */
export function resolveGlobalKey(leader: LeaderState, event: GlobalKeyEvent, context: GlobalKeyContext): GlobalKeyStep {
    if (MODIFIER_KEYS.has(event.key)) {
        return { leader, action: null };
    }
    if (context.isModalOpen) {
        return leader === null ? IDLE : { leader: null, action: { type: 'leaderCancelled' } };
    }
    if (event.key === 'F6' && !event.altKey && !event.metaKey && !event.ctrlKey) {
        return { leader: null, action: { type: 'cycleRegion', delta: event.shiftKey ? -1 : 1 } };
    }
    if (!isLetterShortcutAllowed(event, context)) {
        return leader === null ? IDLE : { leader: null, action: { type: 'leaderCancelled' } };
    }
    const isLeaderLive = leader !== null && context.nowMs - leader <= GO_TO_LEADER_TIMEOUT_MS;
    return isLeaderLive ? resolveAfterLeader(event) : resolveIdle(event, context.nowMs);
}

function isLetterShortcutAllowed(event: GlobalKeyEvent, context: GlobalKeyContext): boolean {
    if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) {
        return false;
    }
    return !event.isComposing && !context.isEditableTarget;
}

function resolveIdle(event: GlobalKeyEvent, nowMs: number): GlobalKeyStep {
    // Shift+G is not the leader (it may become a shortcut of its own); Caps Lock arrives lowercased.
    if (event.key === 'g' && !event.shiftKey) {
        return { leader: nowMs, action: { type: 'leaderStarted' } };
    }
    if (event.key === '?') {
        return { leader: null, action: { type: 'showShortcuts' } };
    }
    return event.key === '/' ? { leader: null, action: { type: 'focusSearch' } } : IDLE;
}

/** The key after `g`: a known target jumps; `?` shows the full list (the user forgot the letter); anything else cancels. */
function resolveAfterLeader(event: GlobalKeyEvent): GlobalKeyStep {
    if (event.key === '?') {
        return { leader: null, action: { type: 'showShortcuts' } };
    }
    const target = GO_TO_TARGETS.find((candidate) => candidate.key === event.key);
    return { leader: null, action: target ? { type: 'goTo', target } : { type: 'leaderCancelled' } };
}
