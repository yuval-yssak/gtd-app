import { isModalOpen } from './keyboardRegionDom';

/** The px one "line" of a line-mode wheel (Firefox on a mouse wheel) stands for. */
export const WHEEL_LINE_PX = 16;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

/** The parts of a `WheelEvent` the rule reads — a plain shape, so tests need no synthetic events. */
export interface StrayWheel {
    target: EventTarget | null;
    deltaX: number;
    deltaY: number;
    deltaMode: number;
    ctrlKey: boolean;
    shiftKey: boolean;
    defaultPrevented: boolean;
}

interface StageScrollScope {
    /** The one scrollport the stray wheels belong to. */
    scroller: HTMLElement;
    /** Only wheels over the app itself count; portaled popups, menus and toasts live outside it. */
    appRoot: HTMLElement;
}

/**
 * How far a wheel that the browser would spend on nothing should scroll the stage instead — or
 * `null` to leave it alone. A wheel is stray when it lands on the app outside the stage and no
 * element under the pointer can scroll that way itself (the header, the pinned action bar, the
 * page padding, a sidebar that fits).
 */
export function strayWheelPixels(wheel: StrayWheel, { scroller, appRoot }: StageScrollScope): number | null {
    const { target } = wheel;
    if (!isVerticalScrollGesture(wheel) || !(target instanceof Element) || !appRoot.contains(target) || scroller.contains(target)) {
        return null;
    }
    if (isModalOpen() || hasOwnScrollToward(target, wheel.deltaY)) {
        return null;
    }
    return toPixels(wheel, scroller.clientHeight);
}

/**
 * A plain vertical wheel: not pinch-zoom (ctrl+wheel), not shift+wheel (sideways, though some
 * platforms still report it as deltaY), not a sideways swipe, not claimed by a handler.
 */
function isVerticalScrollGesture({ deltaX, deltaY, ctrlKey, shiftKey, defaultPrevented }: StrayWheel) {
    return !ctrlKey && !shiftKey && !defaultPrevented && deltaY !== 0 && Math.abs(deltaY) >= Math.abs(deltaX);
}

function toPixels({ deltaY, deltaMode }: StrayWheel, pageHeightPx: number) {
    if (deltaMode === DOM_DELTA_LINE) return deltaY * WHEEL_LINE_PX;
    if (deltaMode === DOM_DELTA_PAGE) return deltaY * pageHeightPx;
    return deltaY;
}

/** Whether the browser will scroll something under the pointer itself, so the wheel is not stray. */
function hasOwnScrollToward(target: Element, deltaY: number) {
    return [...selfAndAncestors(target)].some((el) => isScrollContainer(el) && canScrollToward(el, deltaY));
}

function* selfAndAncestors(el: Element | null): Generator<Element> {
    if (!el) return;
    yield el;
    yield* selfAndAncestors(el.parentElement);
}

function isScrollContainer(el: Element) {
    const { overflowY } = getComputedStyle(el);
    return overflowY === 'auto' || overflowY === 'scroll' || el === el.ownerDocument.scrollingElement;
}

/** A pixel of slack: fractional layouts leave scrollTop a hair short of the true bottom. */
function canScrollToward(el: Element, deltaY: number) {
    return deltaY > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0;
}
