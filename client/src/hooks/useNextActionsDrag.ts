import {
    type KeyboardEvent as ReactKeyboardEvent,
    type PointerEvent as ReactPointerEvent,
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from 'react';
import {
    type DragEffect,
    type DragState,
    dragReducer,
    hasMoveRendered,
    type NeighbourIds,
    needsRender,
    planStep,
    type RowRect,
    type RowStep,
    shiftForRow,
    slotOfNeighbours,
    translateYOf,
} from '../lib/dragReorder';
import type { NextActionSection } from '../lib/nextActionSections';
import { resolveGrabKey } from '../lib/nextActionsKeys';
import { isFocusFree, ROW_HANDLE_ATTR, ROW_ITEM_ATTR, ROW_SECTION_ATTR, rowButtonOf, rowElement, rowHandleOf, whenRowMounted } from '../lib/nextActionsRowDom';
import type { StoredItem } from '../types/MyDB';

/** Touch: the handle must be held this long before a drag starts (D4) — a shorter touch is a tap/scroll. */
export const LONG_PRESS_MS = 250;
/** Touch: moving further than this before the long-press fires cancels it (the user is scrolling). */
export const LONG_PRESS_SLOP_PX = 8;
/** Pointer within this distance of the viewport top/bottom auto-scrolls the window. */
export const AUTO_SCROLL_EDGE_PX = 48;
const AUTO_SCROLL_STEP_PX = 12;
/** The CSS variable rows translate by (`-next-actions.module.css` `.rowShell`). */
export const DRAG_SHIFT_VAR = '--drag-shift';
/** Body class while a pointer drag is live (`user-select: none`, see designSystem/tokens/base.css). */
export const BODY_DRAGGING_CLASS = 'nextActionsDragging';

/** A reorder as the hook hands it to the page: the moved row and the visible neighbours it lands between (by id). */
export interface ReorderCommit extends NeighbourIds {
    sectionKey: string;
    itemId: string;
}

interface UseNextActionsDragOptions {
    sections: ReadonlyArray<NextActionSection<StoredItem>>;
    isGhost: (item: StoredItem) => boolean;
    /** Resolves true when a row was moved (false: no-op, or the row/slot no longer exists); a rejection is surfaced as "Reorder failed". */
    onCommit: (commit: ReorderCommit) => Promise<boolean>;
    /** Brings an UNMOUNTED row into virtua's range (the page maps the id to its virtualizer row index) so it can be focused. */
    scrollRowIntoView?: (itemId: string) => void;
}

export interface HandleProps {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
    onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
    onContextMenu: (e: React.MouseEvent<HTMLElement>) => void;
}

export interface NextActionsDragApi {
    drag: DragState | null;
    /**
     * The grab whose preview order the page should still render: the live keyboard grab, or the
     * one just dropped until its commit has refreshed the list — so the row never snaps back to
     * its origin (and, in a long list, out of virtua's range) between the drop and the refresh.
     */
    previewGrab: DragState | null;
    /** Visually hidden `aria-live` text: slot changes, the committed move, a cancel, a failure. */
    liveText: string;
    /** Set when a commit rejected; the page shows it and clears it with `clearError`. */
    error: string | null;
    clearError: () => void;
    getHandleProps: (item: StoredItem, section: NextActionSection<StoredItem>) => HandleProps;
    /** Space on a focused row: lifts it into keyboard grab mode (the handle's Space/Enter does the same). */
    grab: (item: StoredItem, section: NextActionSection<StoredItem>) => void;
    /** Commits one keyboard step immediately, no grab (D6): Alt+↑/↓ one slot, Alt+Shift+↑/↓ to the section edge. */
    commitStep: (item: StoredItem, section: NextActionSection<StoredItem>, step: RowStep) => void;
    /** Vertical displacement for a NON-dragged row while a drag is live (0 when idle). The dragged row is moved imperatively. */
    shiftFor: (itemId: string) => number;
    /** Commits a reorder from outside the hook (the "Move to…" sheet) through the same queue, announcement and error path. */
    commit: (request: ReorderCommit) => void;
}

/** Live (non-ghost) item ids of a section, in display order. */
function liveIdsOf(section: NextActionSection<StoredItem>, isGhost: (item: StoredItem) => boolean): string[] {
    return section.items.filter((item) => !isGhost(item)).map((item) => item._id);
}

type GrabFocus = 'row' | 'handle';

/** Which of the row's two focusable elements holds focus right now (the one a keyboard grab must give focus back to). */
function grabFocusOf(itemId: string): GrabFocus {
    const active = document.activeElement;
    const row = rowElement(itemId);
    return active && row?.contains(active) && active.closest(`[${ROW_HANDLE_ATTR}]`) ? 'handle' : 'row';
}

/**
 * Keyboard grab: React re-renders the section in preview order, which moves the grabbed row's DOM
 * node — and a moved node loses focus. Waits (a few frames, virtua may still be mounting it at the
 * new slot) for the row, scrolls it into view and focuses the element the grab started from.
 * Never steals focus: a grab cancelled BY focus leaving (Tab out, a click in the search field)
 * must leave focus where the user put it.
 */
function refocusGrabbedRow(itemId: string, target: GrabFocus): void {
    whenRowMounted(itemId, (row) => {
        if (!isFocusFree(row)) {
            return;
        }
        row.scrollIntoView({ block: 'nearest' });
        (target === 'handle' ? rowHandleOf(row) : rowButtonOf(row))?.focus({ preventScroll: true });
    });
}

/**
 * The MOUNTED rows of a section, in DOM (= display) order, as UNTRANSFORMED geometry: rows carry
 * their drag displacement as a transform on the measured element itself, so the current translate
 * is subtracted back out — otherwise a row shifted by a whole row height would move the section
 * wall and the drop midpoints with it. Re-read on every frame: virtua unmounts rows outside the
 * viewport, so a one-time snapshot goes stale on every range change.
 */
function readSectionRects(sectionKey: string): RowRect[] {
    const rows = document.querySelectorAll<HTMLElement>(`[${ROW_SECTION_ATTR}="${CSS.escape(sectionKey)}"][${ROW_ITEM_ATTR}]`);
    return Array.from(rows).map((row) => {
        const rect = row.getBoundingClientRect();
        return { id: row.getAttribute(ROW_ITEM_ATTR) ?? '', top: rect.top - translateYOf(getComputedStyle(row).transform), height: rect.height };
    });
}

function vibrate(ms: number): void {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        navigator.vibrate(ms);
    }
}

/** How far the window should scroll this frame for a pointer at `clientY`, or 0 when away from both edges. */
function autoScrollDelta(clientY: number): number {
    if (clientY < AUTO_SCROLL_EDGE_PX) {
        return -AUTO_SCROLL_STEP_PX;
    }
    return clientY > window.innerHeight - AUTO_SCROLL_EDGE_PX ? AUTO_SCROLL_STEP_PX : 0;
}

/** A queued reorder: the commit, the slot it lands in, what to announce once it landed, and (keyboard gestures) which element to give focus back to. */
interface PlannedCommit {
    commit: ReorderCommit;
    toIndex: number;
    announce: () => void;
    refocus?: GrabFocus;
}

/**
 * A commit that never shows up in the rendered list stops blocking the queue after this long.
 * Only a concurrent pull that makes the planned slot unreachable should ever hit it: a slow
 * device reading and sorting thousands of items must NOT — past this point the row snaps back
 * to the stale order and the next queued step plans against it — so it is generous.
 */
const RENDER_SETTLE_TIMEOUT_MS = 4000;

interface RenderWaiter {
    isSettled: (sections: ReadonlyArray<NextActionSection<StoredItem>>) => boolean;
    resolve: () => void;
}

/** Pointer-drag geometry that changes every frame and must not re-render the page: the row follows it imperatively. */
interface PointerFollow {
    startY: number;
    startScrollY: number;
    lastY: number;
}

interface PendingLongPress {
    timer: ReturnType<typeof setTimeout>;
    startX: number;
    startY: number;
}

/**
 * DOM glue for the Next Actions drag and drop — all decisions live in the pure `dragReducer`;
 * this hook only feeds it pointer/keyboard events and DOM geometry, and renders its effects.
 * Native Pointer Events, no library. While a drag is live its move/up/cancel (and, in grab mode,
 * its keys) are listened for on the WINDOW and attached imperatively at lift: the dragged row can
 * be unmounted by virtua during auto-scroll (which silently releases a handle-bound pointer
 * capture), a touch lift fires from a timer, and a grab-mode handle can lose focus. Proven by
 * Playwright (`e2e/next-actions-reorder*.spec.ts`), not by unit tests — there is no jsdom here.
 */
export function useNextActionsDrag({ sections, isGhost, onCommit, scrollRowIntoView }: UseNextActionsDragOptions): NextActionsDragApi {
    const [drag, setDrag] = useState<DragState | null>(null);
    const [settlingGrab, setSettlingGrab] = useState<DragState | null>(null);
    const [liveText, setLiveText] = useState('');
    const [error, setError] = useState<string | null>(null);
    // Event handlers read the latest state through refs — pointer events outlive a render.
    const dragRef = useRef<DragState | null>(null);
    const sectionsRef = useRef(sections);
    // Commits waiting for their move to show in the rendered sections (see `waitForRender`).
    const renderWaiters = useRef<RenderWaiter[]>([]);
    useLayoutEffect(() => {
        sectionsRef.current = sections;
        const settled = new Set(renderWaiters.current.filter((waiter) => waiter.isSettled(sections)));
        renderWaiters.current = renderWaiters.current.filter((waiter) => !settled.has(waiter));
        for (const waiter of settled) {
            waiter.resolve();
        }
    }, [sections]);

    /**
     * Resolves once the rendered sections satisfy `isSettled` (now, or on a later render), or
     * after a timeout. `refreshItems()` only STARTS a transition; the refreshed list lands some
     * renders later, and a large account's IDB read takes longer than a frame.
     */
    const waitForRender = useCallback(
        (isSettled: RenderWaiter['isSettled']) =>
            new Promise<void>((resolve) => {
                if (isSettled(sectionsRef.current)) {
                    resolve();
                    return;
                }
                // The timer callback runs later, so it may name the waiter declared after it.
                const timer = setTimeout(() => {
                    renderWaiters.current = renderWaiters.current.filter((candidate) => candidate !== waiter);
                    resolve();
                }, RENDER_SETTLE_TIMEOUT_MS);
                const waiter = {
                    isSettled,
                    resolve: () => {
                        clearTimeout(timer);
                        resolve();
                    },
                };
                renderWaiters.current.push(waiter);
            }),
        [],
    );
    const longPress = useRef<PendingLongPress | null>(null);
    const frame = useRef<number | null>(null);
    const follow = useRef<PointerFollow | null>(null);
    const teardown = useRef<(() => void) | null>(null);
    // Commits are serialised: a second gesture before the first persisted would read stale ranks.
    // A COUNT, not a flag: with two commits queued the first one's settle must not reopen the gate.
    const commitChain = useRef<Promise<void>>(Promise.resolve());
    const pendingCommits = useRef(0);

    const sectionByKey = useCallback((key: string) => sectionsRef.current.find((section) => section.key === key), []);

    const announcePosition = useCallback(
        (sectionKey: string, itemId: string, toIndex: number, prefix: string) => {
            const section = sectionByKey(sectionKey);
            const title = section?.items.find((item) => item._id === itemId)?.title ?? 'item';
            const total = section ? liveIdsOf(section, isGhost).length : 0;
            setLiveText(`${prefix}${title} — position ${toIndex + 1} of ${total}`);
        },
        [sectionByKey, isGhost],
    );

    // Grab mode: the page renders the grabbed row AT its slot (preview order), so after every
    // re-render the row itself is scrolled into view and refocused. An unmounted row (the slot
    // scrolled out of virtua's range) is brought in through the virtualizer first.
    const grabFocus = useRef<GrabFocus>('row');
    /**
     * Refocus once the pending render has landed (next frame): only then is it known whether the
     * row is still mounted — after Escape at the far end of a long jump it is back at its origin,
     * out of virtua's range, and must be scrolled back in before it can take focus.
     */
    const refocusRow = useCallback(
        (itemId: string, target: GrabFocus) => {
            requestAnimationFrame(() => {
                if (!rowElement(itemId)) {
                    scrollRowIntoView?.(itemId);
                }
                refocusGrabbedRow(itemId, target);
            });
        },
        [scrollRowIntoView],
    );
    useEffect(() => {
        if (drag?.isKeyboard) {
            refocusRow(drag.itemId, grabFocus.current);
        }
    }, [drag, refocusRow]);

    /** Runs one planned commit and waits until its move is on screen, so the next queued plan reads the rows as they now are. */
    const settleCommit = useCallback(
        async (planned: PlannedCommit) => {
            const { sectionKey, itemId } = planned.commit;
            const moved = await onCommit(planned.commit);
            if (moved) {
                await waitForRender((sections) => {
                    const section = sections.find((candidate) => candidate.key === sectionKey);
                    return hasMoveRendered(section ? liveIdsOf(section, isGhost) : [], itemId, planned.toIndex);
                });
                // Only a real move is announced — a no-op or a vanished row must not read as "Moved".
                planned.announce();
            }
        },
        [onCommit, waitForRender, isGhost],
    );

    /**
     * Queues one reorder behind any in flight. `plan` runs when its turn comes and may return null
     * (nothing to do). A keyboard commit gives focus back once its move has rendered (success or
     * failure: either re-renders the row — a node move that drops focus when the row went DOWN,
     * because React re-inserts the row itself, not its neighbours).
     */
    const runCommit = useCallback(
        (plan: () => PlannedCommit | null) => {
            pendingCommits.current += 1;
            commitChain.current = commitChain.current
                .then(async () => {
                    const planned = plan();
                    if (!planned) {
                        return;
                    }
                    try {
                        await settleCommit(planned);
                    } finally {
                        if (planned.refocus) {
                            refocusRow(planned.commit.itemId, planned.refocus);
                        }
                    }
                })
                .catch((err: unknown) => {
                    console.error('[next-actions] reorder failed', err);
                    setLiveText('Reorder failed');
                    setError('Could not save the new order');
                })
                .finally(() => {
                    // Whatever happened (moved, no-op, failed, or nothing to plan), the dropped grab's preview ends here.
                    setSettlingGrab(null);
                    pendingCommits.current -= 1;
                });
        },
        [settleCommit, refocusRow],
    );

    const runEffects = useCallback(
        (effects: DragEffect[], state: DragState | null, previousState: DragState | null) => {
            for (const effect of effects) {
                if (effect.type === 'slotChanged' && state) {
                    vibrate(10);
                    announcePosition(state.sectionKey, state.itemId, effect.toIndex, '');
                } else if (effect.type === 'commit') {
                    const { sectionKey, itemId, aboveId, belowId, toIndex } = effect;
                    const refocus = effect.isKeyboard ? grabFocus.current : undefined;
                    if (effect.isKeyboard && previousState) {
                        setSettlingGrab(previousState);
                    }
                    runCommit(() => ({
                        commit: { sectionKey, itemId, aboveId, belowId },
                        toIndex,
                        announce: () => announcePosition(sectionKey, itemId, toIndex, 'Moved '),
                        ...(refocus ? { refocus } : {}),
                    }));
                } else if (effect.type === 'snapBack' && effect.hadMoved) {
                    // A press-and-release that never left its slot is not a cancelled reorder — nothing to announce.
                    setLiveText('Reorder cancelled');
                }
            }
        },
        [announcePosition, runCommit],
    );

    /** Clears every per-drag side effect (listeners, frame, body class, the dragged row's transform). */
    const endDrag = useCallback(
        (previous: DragState | null, { isDrop }: { isDrop: boolean }) => {
            teardown.current?.();
            teardown.current = null;
            if (frame.current !== null) {
                cancelAnimationFrame(frame.current);
                frame.current = null;
            }
            if (previous) {
                rowElement(previous.itemId)?.style.removeProperty(DRAG_SHIFT_VAR);
            }
            // A cancel re-renders the row back at its origin (another node move) — give focus back once
            // more. A drop keeps its preview rendered until the commit refreshed the list, and refocuses then.
            if (previous?.isKeyboard && !isDrop) {
                refocusRow(previous.itemId, grabFocus.current);
            }
            follow.current = null;
            document.body.classList.remove(BODY_DRAGGING_CLASS);
        },
        [refocusRow],
    );

    const dispatch = useCallback(
        (event: Parameters<typeof dragReducer>[1]) => {
            const previous = dragRef.current;
            const step = dragReducer(previous, event);
            dragRef.current = step.state;
            if (step.state === null) {
                endDrag(previous, { isDrop: step.effects.some((effect) => effect.type === 'commit') });
            }
            // Geometry-only steps (every pointer frame) do not touch React state — the dragged row
            // follows the pointer imperatively, and only a slot/wall change re-renders the rows.
            if (needsRender(previous, step.state)) {
                setDrag(step.state);
            }
            runEffects(step.effects, step.state, previous);
        },
        [runEffects, endDrag],
    );

    /** Moves the dragged row with the pointer, in page coordinates so auto-scroll does not leave it behind. */
    const followPointer = useCallback(() => {
        const active = dragRef.current;
        const geometry = follow.current;
        if (!active || !geometry) {
            return;
        }
        const shift = geometry.lastY - geometry.startY + (window.scrollY - geometry.startScrollY);
        rowElement(active.itemId)?.style.setProperty(DRAG_SHIFT_VAR, `${shift}px`);
    }, []);

    // One frame per pointer move: auto-scroll if parked at a viewport edge, re-read the mounted
    // rects, re-target once. Near an edge the loop re-arms itself so the window keeps scrolling
    // while the pointer rests there.
    const scheduleFrame = useCallback(() => {
        if (frame.current !== null) {
            return;
        }
        frame.current = requestAnimationFrame(() => {
            frame.current = null;
            const active = dragRef.current;
            const geometry = follow.current;
            if (!active || active.isKeyboard || !geometry) {
                return;
            }
            const delta = autoScrollDelta(geometry.lastY);
            if (delta !== 0) {
                window.scrollBy(0, delta);
            }
            dispatch({ type: 'frame', rects: readSectionRects(active.sectionKey), pointerY: geometry.lastY });
            followPointer();
            if (delta !== 0) {
                scheduleFrame();
            }
        });
    }, [dispatch, followPointer]);

    /** Final re-target at the release point, then drop. */
    const finishPointerDrag = useCallback(
        (clientY: number) => {
            const active = dragRef.current;
            if (!active || active.isKeyboard) {
                return;
            }
            dispatch({ type: 'frame', rects: readSectionRects(active.sectionKey), pointerY: clientY });
            dispatch({ type: 'drop' });
        },
        [dispatch],
    );

    /** A completed drop fires a `click` next; swallow it once (capture) only if it lands inside the dragged row. */
    const swallowNextClickOn = useCallback((itemId: string) => {
        const swallow = (e: MouseEvent) => {
            if (e.target instanceof Element && e.target.closest(`[${ROW_ITEM_ATTR}="${CSS.escape(itemId)}"]`)) {
                e.stopPropagation();
                e.preventDefault();
            }
        };
        document.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 300);
    }, []);

    const attachPointerListeners = useCallback(
        (itemId: string) => {
            const onPointerMove = (e: PointerEvent) => {
                if (follow.current) {
                    follow.current.lastY = e.clientY;
                }
                scheduleFrame();
            };
            const onPointerUp = (e: PointerEvent) => {
                swallowNextClickOn(itemId);
                finishPointerDrag(e.clientY);
            };
            const cancel = () => dispatch({ type: 'cancel' });
            const onKeyDown = (e: KeyboardEvent) => {
                if (e.key === 'Escape') {
                    cancel();
                }
            };
            const onVisibility = () => {
                if (document.visibilityState === 'hidden') {
                    cancel();
                }
            };
            window.addEventListener('pointermove', onPointerMove);
            window.addEventListener('pointerup', onPointerUp);
            window.addEventListener('pointercancel', cancel);
            window.addEventListener('blur', cancel);
            window.addEventListener('keydown', onKeyDown);
            document.addEventListener('visibilitychange', onVisibility);
            teardown.current = () => {
                window.removeEventListener('pointermove', onPointerMove);
                window.removeEventListener('pointerup', onPointerUp);
                window.removeEventListener('pointercancel', cancel);
                window.removeEventListener('blur', cancel);
                window.removeEventListener('keydown', onKeyDown);
                document.removeEventListener('visibilitychange', onVisibility);
            };
        },
        [scheduleFrame, finishPointerDrag, dispatch, swallowNextClickOn],
    );

    // Grab mode lives on the window too: the focused handle can scroll out of virtua's range (and
    // out of the DOM) while the slot moves, Tab or a click can take focus — none of that may leave a
    // drag that no key can end. Any pointer press cancels it.
    const attachKeyboardListeners = useCallback(
        (draggedId: string) => {
            // Capture phase, and the event is stopped: the row button (a non-native MUI button) would
            // otherwise turn the Enter that drops the row into a click that opens the editor.
            const onKeyDown = (e: KeyboardEvent) => {
                const action = resolveGrabKey(e);
                if (action) {
                    e.preventDefault();
                    e.stopPropagation();
                    dispatch(action);
                }
            };
            const cancel = () => dispatch({ type: 'cancel' });
            // Focus leaving the dragged row (Tab to the search field or to another row's controls) ends the
            // grab too: Space or Enter typed there must not drop this row.
            const onFocusIn = (e: FocusEvent) => {
                if (!(e.target instanceof Element && e.target.closest(`[${ROW_ITEM_ATTR}="${CSS.escape(draggedId)}"]`))) {
                    cancel();
                }
            };
            window.addEventListener('keydown', onKeyDown, { capture: true });
            window.addEventListener('pointerdown', cancel);
            window.addEventListener('blur', cancel);
            document.addEventListener('focusin', onFocusIn);
            teardown.current = () => {
                window.removeEventListener('keydown', onKeyDown, { capture: true });
                window.removeEventListener('pointerdown', cancel);
                window.removeEventListener('blur', cancel);
                document.removeEventListener('focusin', onFocusIn);
            };
        },
        [dispatch],
    );

    const lift = useCallback(
        (item: StoredItem, section: NextActionSection<StoredItem>, pointer: { clientY: number } | null) => {
            if (dragRef.current || pendingCommits.current > 0) {
                return;
            }
            const itemIds = liveIdsOf(section, isGhost);
            const rects = readSectionRects(section.key);
            if (pointer) {
                follow.current = { startY: pointer.clientY, startScrollY: window.scrollY, lastY: pointer.clientY };
                document.body.classList.add(BODY_DRAGGING_CLASS);
                attachPointerListeners(item._id);
            } else {
                grabFocus.current = grabFocusOf(item._id);
                attachKeyboardListeners(item._id);
            }
            dispatch({
                type: 'lift',
                itemId: item._id,
                sectionKey: section.key,
                itemIds,
                rects,
                pointerY: pointer?.clientY ?? 0,
                isKeyboard: pointer === null,
            });
            if (dragRef.current) {
                vibrate(10);
            } else {
                endDrag(null, { isDrop: false });
                rowElement(item._id)?.style.removeProperty(DRAG_SHIFT_VAR);
            }
        },
        [dispatch, isGhost, attachPointerListeners, attachKeyboardListeners, endDrag],
    );

    const cancelLongPress = useCallback(() => {
        if (longPress.current) {
            clearTimeout(longPress.current.timer);
            longPress.current = null;
        }
    }, []);

    // Unmount: end any gesture, and let the commits waiting for a render finish now — nothing will
    // render their moves here any more.
    useEffect(
        () => () => {
            cancelLongPress();
            endDrag(dragRef.current, { isDrop: false });
            for (const waiter of renderWaiters.current) {
                waiter.resolve();
            }
            renderWaiters.current = [];
        },
        [cancelLongPress, endDrag],
    );

    // The grabbed row left the list (completed on another device, pulled away): a grab with no row
    // has nothing to drop, and its window listeners would swallow keys until some key ended it.
    useEffect(() => {
        const active = dragRef.current;
        const section = active ? sections.find((candidate) => candidate.key === active.sectionKey) : undefined;
        if (active && !section?.items.some((item) => item._id === active.itemId && !isGhost(item))) {
            dispatch({ type: 'cancel' });
        }
    }, [sections, isGhost, dispatch]);

    const getHandleProps = useCallback(
        (item: StoredItem, section: NextActionSection<StoredItem>): HandleProps => ({
            onPointerDown: (e) => {
                if (e.button !== 0 || dragRef.current || pendingCommits.current > 0) {
                    return;
                }
                e.stopPropagation();
                e.currentTarget.setPointerCapture(e.pointerId);
                if (e.pointerType !== 'touch') {
                    lift(item, section, { clientY: e.clientY });
                    return;
                }
                const clientY = e.clientY;
                longPress.current = {
                    timer: setTimeout(() => {
                        longPress.current = null;
                        lift(item, section, { clientY });
                    }, LONG_PRESS_MS),
                    startX: e.clientX,
                    startY: e.clientY,
                };
            },
            // Only the long-press phase lives on the handle; once lifted, the window listeners own
            // move/up/cancel (see `attachPointerListeners`).
            onPointerMove: (e) => {
                const pending = longPress.current;
                if (pending && Math.hypot(e.clientX - pending.startX, e.clientY - pending.startY) > LONG_PRESS_SLOP_PX) {
                    cancelLongPress();
                }
            },
            onPointerUp: () => cancelLongPress(),
            onPointerCancel: () => cancelLongPress(),
            // Space/Enter lifts into grab mode; every later key is handled on the window (its capture
            // listener is attached during this dispatch, so it cannot see this very event). The
            // stopPropagation keeps the list's roving-focus handler from treating the Space as a grab too.
            onKeyDown: (e) => {
                if ((e.key === ' ' || e.key === 'Enter') && !dragRef.current) {
                    e.preventDefault();
                    e.stopPropagation();
                    lift(item, section, null);
                }
            },
            // A long press on the handle must not open the browser's context menu / iOS callout.
            onContextMenu: (e) => e.preventDefault(),
        }),
        [lift, cancelLongPress],
    );

    const grab = useCallback(
        (item: StoredItem, section: NextActionSection<StoredItem>) => {
            if (!dragRef.current) {
                lift(item, section, null);
            }
        },
        [lift],
    );

    // Committed keyboard steps queue behind each other and plan against the rows CURRENT when they
    // run, so three quick Alt+↑ presses climb three slots. (Key repeat is filtered by the resolver.)
    const commitStep = useCallback(
        (item: StoredItem, section: NextActionSection<StoredItem>, step: RowStep) => {
            if (dragRef.current) {
                return;
            }
            const refocus = grabFocusOf(item._id);
            runCommit(() => {
                const current = sectionByKey(section.key);
                const planned = planStep(current ? liveIdsOf(current, isGhost) : [], item._id, step);
                if (!planned) {
                    return null;
                }
                return {
                    commit: { sectionKey: section.key, itemId: item._id, ...planned.neighbours },
                    toIndex: planned.toIndex,
                    announce: () => announcePosition(section.key, item._id, planned.toIndex, 'Moved '),
                    refocus,
                };
            });
        },
        [isGhost, runCommit, announcePosition, sectionByKey],
    );

    /** The one entry for gestures outside the hook (the "Move to…" sheet): queued, announced and error-surfaced like a drag. */
    const commit = useCallback(
        (request: ReorderCommit) => {
            runCommit(() => {
                const section = sectionByKey(request.sectionKey);
                const toIndex = slotOfNeighbours(section ? liveIdsOf(section, isGhost) : [], request.itemId, request.belowId);
                return { commit: request, toIndex, announce: () => announcePosition(request.sectionKey, request.itemId, toIndex, 'Moved ') };
            });
        },
        [runCommit, sectionByKey, isGhost, announcePosition],
    );

    const shiftFor = useCallback((itemId: string) => (drag && drag.itemId !== itemId ? shiftForRow(drag, itemId) : 0), [drag]);
    const clearError = useCallback(() => setError(null), []);

    return { drag, previewGrab: drag?.isKeyboard ? drag : settlingGrab, liveText, error, clearError, getHandleProps, grab, commitStep, shiftFor, commit };
}
