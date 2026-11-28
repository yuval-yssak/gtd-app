// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { MODAL_POPUP_ATTR } from '../lib/keyboardRegionDom';
import { type StrayWheel, strayWheelPixels, WHEEL_LINE_PX } from '../lib/strayWheel';

/**
 * The review page as the rule sees it: the app root holds a header beside the stage's scroller,
 * a nav that may scroll itself, and portaled popups live outside the root.
 */
function mountReviewPage() {
    document.body.innerHTML = `
        <div id="root">
            <nav id="nav" style="overflow-y: auto"><a id="navLink">Inbox</a></nav>
            <main>
                <header id="header"><h1 id="title">Next actions</h1><ol id="stepper" style="overflow-x: auto"><li id="step">Inbox</li></ol></header>
                <div id="scroller" style="overflow-y: auto"><textarea id="notes"></textarea></div>
            </main>
        </div>
        <div id="portal"><button id="menuItem">Open</button></div>`;
    const byId = (id: string) => {
        const el = document.getElementById(id);
        if (!el) throw new Error(`expected #${id}`);
        return el;
    };
    setScrollBox(byId('scroller'), { scrollTop: 0, scrollHeight: 2000, clientHeight: 500 });
    setScrollBox(byId('nav'), { scrollTop: 0, scrollHeight: 300, clientHeight: 300 });
    setScrollBox(byId('stepper'), { scrollTop: 0, scrollHeight: 40, clientHeight: 40 });
    return { byId, appRoot: byId('root'), scroller: byId('scroller') };
}

function setScrollBox(el: HTMLElement, box: { scrollTop: number; scrollHeight: number; clientHeight: number }) {
    Object.defineProperty(el, 'scrollTop', { configurable: true, value: box.scrollTop });
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: box.scrollHeight });
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: box.clientHeight });
}

function wheelOn(target: Element, overrides: Partial<StrayWheel> = {}): StrayWheel {
    return { target, deltaX: 0, deltaY: 120, deltaMode: 0, ctrlKey: false, shiftKey: false, defaultPrevented: false, ...overrides };
}

afterEach(() => {
    document.body.innerHTML = '';
});

describe('strayWheelPixels', () => {
    it('forwards a wheel over the page outside the stage', () => {
        const { byId, appRoot, scroller } = mountReviewPage();
        expect(strayWheelPixels(wheelOn(byId('title')), { scroller, appRoot })).toBe(120);
        expect(strayWheelPixels(wheelOn(byId('title'), { deltaY: -40 }), { scroller, appRoot })).toBe(-40);
    });

    it('leaves a wheel inside the stage to the browser', () => {
        const { byId, appRoot, scroller } = mountReviewPage();
        expect(strayWheelPixels(wheelOn(byId('notes')), { scroller, appRoot })).toBeNull();
        expect(strayWheelPixels(wheelOn(scroller), { scroller, appRoot })).toBeNull();
    });

    it('leaves a wheel to an outside element that scrolls that way itself, and forwards it once that element is at its end', () => {
        const { byId, appRoot, scroller } = mountReviewPage();
        const nav = byId('nav');
        setScrollBox(nav, { scrollTop: 0, scrollHeight: 900, clientHeight: 300 });
        expect(strayWheelPixels(wheelOn(byId('navLink')), { scroller, appRoot })).toBeNull();
        // At the top already: scrolling up is the stage's.
        expect(strayWheelPixels(wheelOn(byId('navLink'), { deltaY: -120 }), { scroller, appRoot })).toBe(-120);
        setScrollBox(nav, { scrollTop: 600, scrollHeight: 900, clientHeight: 300 });
        expect(strayWheelPixels(wheelOn(byId('navLink')), { scroller, appRoot })).toBe(120);
    });

    it('forwards over a sideways scroller that has nothing to scroll vertically (overflow-x makes overflow-y auto too)', () => {
        const { byId, appRoot, scroller } = mountReviewPage();
        expect(strayWheelPixels(wheelOn(byId('step')), { scroller, appRoot })).toBe(120);
    });

    it('never forwards from a portaled popup or while a modal is open', () => {
        const { byId, appRoot, scroller } = mountReviewPage();
        expect(strayWheelPixels(wheelOn(byId('menuItem')), { scroller, appRoot })).toBeNull();
        byId('portal').insertAdjacentHTML('beforeend', `<div ${MODAL_POPUP_ATTR} data-open role="dialog"></div>`);
        expect(strayWheelPixels(wheelOn(byId('title')), { scroller, appRoot })).toBeNull();
    });

    it('ignores pinch-zoom, shift+wheel, horizontal swipes and wheels a handler already claimed', () => {
        const { byId, appRoot, scroller } = mountReviewPage();
        const title = byId('title');
        expect(strayWheelPixels(wheelOn(title, { ctrlKey: true }), { scroller, appRoot })).toBeNull();
        // Shift+wheel means sideways, even where the platform still reports it as deltaY.
        expect(strayWheelPixels(wheelOn(title, { shiftKey: true }), { scroller, appRoot })).toBeNull();
        expect(strayWheelPixels(wheelOn(title, { deltaX: 200, deltaY: 30 }), { scroller, appRoot })).toBeNull();
        expect(strayWheelPixels(wheelOn(title, { defaultPrevented: true }), { scroller, appRoot })).toBeNull();
        expect(strayWheelPixels(wheelOn(title, { deltaY: 0 }), { scroller, appRoot })).toBeNull();
    });

    it('converts line and page wheels to pixels', () => {
        const { byId, appRoot, scroller } = mountReviewPage();
        expect(strayWheelPixels(wheelOn(byId('title'), { deltaY: 3, deltaMode: 1 }), { scroller, appRoot })).toBe(3 * WHEEL_LINE_PX);
        expect(strayWheelPixels(wheelOn(byId('title'), { deltaY: 1, deltaMode: 2 }), { scroller, appRoot })).toBe(500);
    });
});
