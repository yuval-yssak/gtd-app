import { useNavigate } from '@tanstack/react-router';
import dayjs from 'dayjs';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { GHOST_ROW_ATTR } from '../components/ListRowShell';
import { isEditableEventTarget } from '../components/quickCapture/quickCaptureLogic';
import { type GlobalKeyAction, type LeaderState, leaderRemainingMs, resolveGlobalKey, shortcutKeyOf } from '../lib/globalShortcuts';
import { focusRegionFromKeyboard, isModalOpen, LIST_SEARCH_INPUT_ATTR, LIST_SEARCH_TOGGLE_ATTR, visibleRegions } from '../lib/keyboardRegionDom';
import { nextRegionIndex } from '../lib/rovingRegion';
import { EVERY_ROW_ACTIONS, ROW_ACTION_ATTR, rowActionForKey, SHORTCUT_ROW_ATTR } from '../lib/rowShortcuts';
import { openShortcutsDialog } from '../lib/shortcutsDialogStore';

type PerformedAction = Exclude<GlobalKeyAction, { type: 'leaderStarted' } | { type: 'leaderCancelled' }>;
type Navigate = ReturnType<typeof useNavigate>;

/** F6 / Shift+F6: focus the next / previous region on screen (wrapping). False when there is none to move to. */
function cycleRegion(delta: 1 | -1): boolean {
    const regions = visibleRegions();
    const active = document.activeElement;
    const next = nextRegionIndex(
        regions.length,
        regions.findIndex((region) => active !== null && region.contains(active)),
        delta,
    );
    const target = next === null ? undefined : regions[next];
    if (target) {
        focusRegionFromKeyboard(target);
    }
    return target !== undefined;
}

/** `/`: focus the open list search, or open it (the field autofocuses). False on pages without one — the key then stays the browser's. */
function focusListSearch(): boolean {
    const input = document.querySelector<HTMLElement>(`[${LIST_SEARCH_INPUT_ATTR}]`);
    if (input) {
        input.focus();
        return true;
    }
    const toggle = document.querySelector<HTMLElement>(`[${LIST_SEARCH_TOGGLE_ATTR}]`);
    toggle?.click();
    return toggle !== null;
}

/** Runs a resolved shortcut; returns whether it acted (only then is the key consumed). Exhaustive over the action union. */
function performShortcut(action: PerformedAction, navigate: Navigate): boolean {
    switch (action.type) {
        case 'goTo':
            void navigate({ to: action.target.to });
            return true;
        case 'showShortcuts':
            openShortcutsDialog();
            return true;
        case 'focusSearch':
            return focusListSearch();
        case 'cycleRegion':
            return cycleRegion(action.delta);
    }
}

/**
 * Whether a resolved step consumes its key: `g` itself (so a focused row or the browser's
 * find-as-you-type never sees it) and any shortcut that actually acted. A cancelled leader, or `/`
 * on a page without a list search, leaves the key to the page and the browser.
 */
function consumesKey(action: GlobalKeyAction | null, navigate: Navigate): boolean {
    if (action === null || action.type === 'leaderCancelled') {
        return false;
    }
    return action.type === 'leaderStarted' || performShortcut(action, navigate);
}

/**
 * A bare letter on a focused list row presses that row's button (E edits, C copies the id) — on
 * every list page. Returns whether the key belongs to the row: inside a row a row letter is always
 * the row's, even when there is nothing to press (a fading ghost acts on a stale snapshot, a People
 * row has no copy button) — it must not fall through to quick capture's `c`. The Next Actions list
 * handles its own letters, with its guards, and carries no row marker (there C still copies a
 * ghost's id).
 */
function pressRowShortcut(event: KeyboardEvent, key: string): boolean {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat || !(event.target instanceof Element)) {
        return false;
    }
    const row = event.target.closest<HTMLElement>(`[${SHORTCUT_ROW_ATTR}]`);
    const action = rowActionForKey(key, EVERY_ROW_ACTIONS);
    if (!row || !action) {
        return false;
    }
    if (!row.closest(`[${GHOST_ROW_ATTR}]`)) {
        row.querySelector<HTMLElement>(`[${ROW_ACTION_ATTR}="${action}"]:not([disabled])`)?.click();
    }
    return true;
}

/** The machine's view of a DOM keydown: the layout-independent key plus modifiers. */
function toGlobalKeyEvent(event: KeyboardEvent) {
    const { altKey, shiftKey, metaKey, ctrlKey, repeat, isComposing } = event;
    return { key: shortcutKeyOf(event.key, event.code, shiftKey), altKey, shiftKey, metaKey, ctrlKey, repeat, isComposing };
}

/**
 * The page-independent shortcuts (`g` jumps, `?`, `/`, F6), mounted once by the authenticated
 * layout. Listens in the CAPTURE phase on the window: the key after `g` must be swallowed before
 * a focused list row sees it — `g d` must go to Done, never mark the focused row done.
 * Returns whether a `g` is pending, for the on-screen hint.
 */
export function useGlobalShortcuts() {
    const navigate = useNavigate();
    const leader = useRef<LeaderState>(null);
    const leaderTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);
    const [isLeaderPending, setIsLeaderPending] = useState(false);
    const navigateRef = useRef(navigate);
    useLayoutEffect(() => {
        navigateRef.current = navigate;
    }, [navigate]);

    useEffect(() => {
        // Unchanged leader (a bare modifier keydown) keeps its timer: the hint must vanish exactly when
        // the jump stops working, which `resolveGlobalKey` measures from the `g` press.
        const setLeader = (next: LeaderState, nowMs: number) => {
            if (next === leader.current) {
                return;
            }
            leader.current = next;
            setIsLeaderPending(next !== null);
            clearTimeout(leaderTimeout.current);
            if (next !== null) {
                leaderTimeout.current = setTimeout(() => setLeader(null, dayjs().valueOf()), leaderRemainingMs(next, nowMs));
            }
        };
        const onKeyDown = (event: KeyboardEvent) => {
            const nowMs = dayjs().valueOf();
            const context = { isEditableTarget: isEditableEventTarget(event.target), isModalOpen: isModalOpen(), nowMs };
            const keyEvent = toGlobalKeyEvent(event);
            const step = resolveGlobalKey(leader.current, keyEvent, context);
            setLeader(step.leader, nowMs);
            // Row letters only when no global shortcut claimed the key (a pending or just-cancelled `g` included);
            // pressRowShortcut presses the row's button as a side effect and reports whether the key was the row's.
            const isRowLetter = step.action === null && !context.isEditableTarget && !context.isModalOpen && pressRowShortcut(event, keyEvent.key);
            if (isRowLetter || consumesKey(step.action, navigateRef.current)) {
                // No row shortcut, quick capture or browser default may act on the same key.
                event.preventDefault();
                event.stopPropagation();
            }
        };
        window.addEventListener('keydown', onKeyDown, { capture: true });
        return () => {
            window.removeEventListener('keydown', onKeyDown, { capture: true });
            clearTimeout(leaderTimeout.current);
        };
    }, []);

    return { isLeaderPending };
}
