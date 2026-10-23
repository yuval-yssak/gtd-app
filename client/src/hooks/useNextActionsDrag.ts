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
    type NeighbourIds,
    needsRender,
    nudgeNeighbours,
    othersOf,
    type RowRect,
    shiftForRow,
    translateYOf,
} from '../lib/dragReorder';
import type { NextActionSection } from '../lib/nextActionSections';
import type { StoredItem } from '../types/MyDB';

/** Touch: the handle must be held this long before a drag starts (D4) — a shorter touch is a tap/scroll. */
export const LONG_PRESS_MS = 250;
/** Touch: moving further than this before the long-press fires cancels it (the user is scrolling). */
export const LONG_PRESS_SLOP_PX = 8;
/** Pointer within this distance of the viewport top/bottom auto-scrolls the window. */
export const AUTO_SCROLL_EDGE_PX = 48;
const AUTO_SCROLL_STEP_PX = 12;
/** Attributes every draggable row carries — the hook reads rects through them. */
export const ROW_SECTION_ATTR = 'data-section-key';
export const ROW_ITEM_ATTR = 'data-item-id';
/** The CSS variable rows translate by (`-next-actions.module.css` `.rowShell`). */
export const DRAG_SHIFT_VAR = '--drag-shift';
/** Body class while a pointer drag is live (`user-select: none`, see index.css). */
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
    /** Grab mode: keep the target slot visible (the page maps it to a virtualizer row index). */
    scrollSlotIntoView?: (sectionKey: string, toIndex: number) => void;
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
    /** Visually hidden `aria-live` text: slot changes, the committed move, a cancel, a failure. */
    liveText: string;
    /** Set when a commit rejected; the page shows it and clears it with `clearError`. */
    error: string | null;
    clearError: () => void;
    getHandleProps: (item: StoredItem, section: NextActionSection<StoredItem>) => HandleProps;
    /** `Alt+↑/↓` on the focused row commits one slot immediately (D6). */
    onRowKeyDown: (item: StoredItem, section: NextActionSection<StoredItem>, e: ReactKeyboardEvent<HTMLElement>) => void;
    /** Vertical displacement for a NON-dragged row while a drag is live (0 when idle). The dragged row is moved imperatively. */
    shiftFor: (itemId: string) => number;
    /** Commits a reorder from outside the hook (the "Move to…" sheet) through the same queue, announcement and error path. */
    commit: (request: ReorderCommit) => void;
}

/** Live (non-ghost) item ids of a section, in display order. */
function liveIdsOf(section: NextActionSection<StoredItem>, isGhost: (item: StoredItem) => boolean): string[] {
    return section.items.filter((item) => !isGhost(item)).map((item) => item._id);
}

function rowElement(itemId: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[${ROW_ITEM_ATTR}="${CSS.escape(itemId)}"]`);
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
export function useNextActionsDrag({ sections, isGhost, onCommit, scrollSlotIntoView }: UseNextActionsDragOptions): NextActionsDragApi {
    const [drag, setDrag] = useState<DragState | null>(null);
    const [liveText, setLiveText] = useState('');
    const [error, setError] = useState<string | null>(null);
    // Event handlers read the latest state through refs — pointer events outlive a render.
    const dragRef = useRef<DragState | null>(null);
    const sectionsRef = useRef(sections);
    useLayoutEffect(() => {
        sectionsRef.current = sections;
    }, [sections]);
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

    /**
     * Queues one reorder behind any in flight. `plan` runs when its turn comes and may return null
     * (nothing to do); after the commit a frame is awaited so the refreshed list has rendered and
     * the next queued plan reads current rows through `sectionsRef`.
     */
    const runCommit = useCallback(
        (plan: () => { commit: ReorderCommit; announce: () => void } | null) => {
            pendingCommits.current += 1;
            commitChain.current = commitChain.current
                .then(async () => {
                    const planned = plan();
                    if (!planned) {
                        return;
                    }
                    const moved = await onCommit(planned.commit);
                    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
                    // Only a real move is announced — a no-op or a vanished row must not read as "Moved".
                    if (moved) {
                        planned.announce();
                    }
                })
                .catch((err: unknown) => {
                    console.error('[next-actions] reorder failed', err);
                    setLiveText('Reorder failed');
                    setError('Could not save the new order');
                })
                .finally(() => {
                    pendingCommits.current -= 1;
                });
        },
        [onCommit],
    );

    // Grab mode: keep the row at the target slot in view. A MOUNTED row scrolls natively (minimal,
    // synchronous); only an unmounted one goes through the virtualizer, whose scrollToIndex settles
    // asynchronously over several frames and must not be fired for rows that are already visible.
    const keepSlotVisible = useCallback(
        (state: DragState, toIndex: number) => {
            const others = othersOf(state.itemIds, state.itemId);
            const targetId = others[Math.min(toIndex, others.length - 1)];
            const mounted = targetId === undefined ? null : rowElement(targetId);
            if (mounted) {
                mounted.scrollIntoView({ block: 'nearest' });
                return;
            }
            scrollSlotIntoView?.(state.sectionKey, toIndex);
        },
        [scrollSlotIntoView],
    );

    const runEffects = useCallback(
        (effects: DragEffect[], state: DragState | null) => {
            for (const effect of effects) {
                if (effect.type === 'slotChanged' && state) {
                    vibrate(10);
                    announcePosition(state.sectionKey, state.itemId, effect.toIndex, '');
                    if (state.isKeyboard) {
                        keepSlotVisible(state, effect.toIndex);
                    }
                } else if (effect.type === 'commit') {
                    const { sectionKey, itemId, aboveId, belowId, toIndex } = effect;
                    runCommit(() => ({
                        commit: { sectionKey, itemId, aboveId, belowId },
                        announce: () => announcePosition(sectionKey, itemId, toIndex, 'Moved '),
                    }));
                } else if (effect.type === 'snapBack' && effect.hadMoved) {
                    // A press-and-release that never left its slot is not a cancelled reorder — nothing to announce.
                    setLiveText('Reorder cancelled');
                }
            }
        },
        [announcePosition, runCommit, keepSlotVisible],
    );

    /** Clears every per-drag side effect (listeners, frame, body class, the dragged row's transform). */
    const endDrag = useCallback((draggedId: string | undefined) => {
        teardown.current?.();
        teardown.current = null;
        if (frame.current !== null) {
            cancelAnimationFrame(frame.current);
            frame.current = null;
        }
        if (draggedId !== undefined) {
            rowElement(draggedId)?.style.removeProperty(DRAG_SHIFT_VAR);
        }
        follow.current = null;
        document.body.classList.remove(BODY_DRAGGING_CLASS);
    }, []);

    const dispatch = useCallback(
        (event: Parameters<typeof dragReducer>[1]) => {
            const previous = dragRef.current;
            const step = dragReducer(previous, event);
            dragRef.current = step.state;
            if (step.state === null) {
                endDrag(previous?.itemId);
            }
            // Geometry-only steps (every pointer frame) do not touch React state — the dragged row
            // follows the pointer imperatively, and only a slot/wall change re-renders the rows.
            if (needsRender(previous, step.state)) {
                setDrag(step.state);
            }
            runEffects(step.effects, step.state);
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
            const onKeyDown = (e: KeyboardEvent) => {
                if (e.key === ' ' || e.key === 'Enter') {
                    e.preventDefault();
                    dispatch({ type: 'drop' });
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    dispatch({ type: 'cancel' });
                } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    dispatch({ type: 'nudge', delta: e.key === 'ArrowUp' ? -1 : 1 });
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
            window.addEventListener('keydown', onKeyDown);
            window.addEventListener('pointerdown', cancel);
            window.addEventListener('blur', cancel);
            document.addEventListener('focusin', onFocusIn);
            teardown.current = () => {
                window.removeEventListener('keydown', onKeyDown);
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
                endDrag(item._id);
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

    useEffect(
        () => () => {
            cancelLongPress();
            endDrag(dragRef.current?.itemId);
        },
        [cancelLongPress, endDrag],
    );

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
            // Space/Enter lifts into grab mode; every later key is handled on the window. The lifting
            // keydown must not reach the window listener attached during the lift (it would read as
            // the drop and end the grab at once), hence the stopPropagation.
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

    // Alt+arrow nudges queue behind each other and plan against the rows CURRENT when they run,
    // so three quick presses climb three slots. Key repeat is ignored: holding the key would queue
    // one commit per repeat.
    const onRowKeyDown = useCallback(
        (item: StoredItem, section: NextActionSection<StoredItem>, e: ReactKeyboardEvent<HTMLElement>) => {
            if (!e.altKey || e.repeat || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || dragRef.current) {
                return;
            }
            e.preventDefault();
            const delta = e.key === 'ArrowUp' ? -1 : 1;
            runCommit(() => {
                const current = sectionByKey(section.key);
                const itemIds = current ? liveIdsOf(current, isGhost) : [];
                const neighbours = nudgeNeighbours(itemIds, item._id, delta);
                if (!neighbours) {
                    return null;
                }
                const toIndex = itemIds.indexOf(item._id) + delta;
                return {
                    commit: { sectionKey: section.key, itemId: item._id, ...neighbours },
                    announce: () => announcePosition(section.key, item._id, toIndex, 'Moved '),
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
                const itemIds = section ? liveIdsOf(section, isGhost) : [];
                const others = itemIds.filter((id) => id !== request.itemId);
                const toIndex = request.belowId === undefined ? others.length : Math.max(others.indexOf(request.belowId), 0);
                return { commit: request, announce: () => announcePosition(request.sectionKey, request.itemId, toIndex, 'Moved ') };
            });
        },
        [runCommit, sectionByKey, isGhost, announcePosition],
    );

    const shiftFor = useCallback((itemId: string) => (drag && drag.itemId !== itemId ? shiftForRow(drag, itemId) : 0), [drag]);
    const clearError = useCallback(() => setError(null), []);

    return { drag, liveText, error, clearError, getHandleProps, onRowKeyDown, shiftFor, commit };
}
