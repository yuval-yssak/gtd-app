import { afterEach, describe, expect, it, vi } from 'vitest';
import { isNewTabClick, navigateOrOpenNewTab, type RouterNavigator } from '../lib/newTabNavigation';

// isNewTabClick gates every entity-open click handler: a modified click must open the
// entity page in a new tab instead of running the in-tab action (editor, navigation).
describe('isNewTabClick', () => {
    it('detects cmd+click (macOS)', () => {
        expect(isNewTabClick({ metaKey: true, ctrlKey: false }, true)).toBe(true);
    });

    it('detects ctrl+click on Windows/Linux', () => {
        expect(isNewTabClick({ metaKey: false, ctrlKey: true }, false)).toBe(true);
    });

    it('rejects ctrl+click on Apple platforms — that gesture is the context menu, not new-tab', () => {
        expect(isNewTabClick({ metaKey: false, ctrlKey: true }, true)).toBe(false);
    });

    it('treats a plain click as in-tab on every platform', () => {
        expect(isNewTabClick({ metaKey: false, ctrlKey: false }, true)).toBe(false);
        expect(isNewTabClick({ metaKey: false, ctrlKey: false }, false)).toBe(false);
    });
});

// navigateOrOpenNewTab holds all the branching behind useNewTabAwareNavigate; the router is
// injected so the window.open / navigate dispatch is testable without a React renderer.
describe('navigateOrOpenNewTab', () => {
    function makeRouter() {
        return {
            buildLocation: vi.fn(() => ({ href: '/item/abc?status=null' })),
            navigate: vi.fn(),
        } satisfies RouterNavigator;
    }
    const target = { to: '/item/$itemId', params: { itemId: 'abc' } } as const;

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('opens the built href in a new tab on a modified click and does not navigate in-tab', () => {
        const router = makeRouter();
        const openSpy = vi.fn(() => ({}) as Window);
        vi.stubGlobal('window', { open: openSpy });

        navigateOrOpenNewTab(router, { metaKey: true, ctrlKey: false }, target);

        expect(openSpy).toHaveBeenCalledWith('/item/abc?status=null', '_blank');
        expect(router.navigate).not.toHaveBeenCalled();
    });

    it('navigates in-tab on a plain click and never opens a window', () => {
        const router = makeRouter();
        const openSpy = vi.fn(() => ({}) as Window);
        vi.stubGlobal('window', { open: openSpy });

        navigateOrOpenNewTab(router, { metaKey: false, ctrlKey: false }, target);

        expect(openSpy).not.toHaveBeenCalled();
        expect(router.navigate).toHaveBeenCalledWith(target);
    });

    it('always navigates in-tab when no event is passed (the programmatic-navigation contract)', () => {
        const router = makeRouter();
        const openSpy = vi.fn(() => ({}) as Window);
        vi.stubGlobal('window', { open: openSpy });

        navigateOrOpenNewTab(router, undefined, target);

        expect(openSpy).not.toHaveBeenCalled();
        expect(router.navigate).toHaveBeenCalledWith(target);
    });

    it('falls back to in-tab navigation when a popup blocker swallows window.open', () => {
        const router = makeRouter();
        vi.stubGlobal('window', { open: vi.fn(() => null) });

        navigateOrOpenNewTab(router, { metaKey: true, ctrlKey: false }, target);

        expect(router.navigate).toHaveBeenCalledWith(target);
    });
});
