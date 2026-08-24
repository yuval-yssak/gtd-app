import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureShortcutContext, CaptureShortcutEvent } from '../components/quickCapture/quickCaptureLogic';
import { isEditableEventTarget, shouldOpenQuickCapture } from '../components/quickCapture/quickCaptureLogic';

function makeEvent(overrides: Partial<CaptureShortcutEvent> = {}): CaptureShortcutEvent {
    return { key: 'c', metaKey: false, ctrlKey: false, altKey: false, defaultPrevented: false, isComposing: false, ...overrides };
}

const idleContext: CaptureShortcutContext = { isModalOpen: false, isEditableTarget: false };

describe('shouldOpenQuickCapture', () => {
    it('fires on a bare "c" with nothing else open', () => {
        expect(shouldOpenQuickCapture(makeEvent(), idleContext)).toBe(true);
    });

    it('accepts uppercase C (shift held or caps lock)', () => {
        expect(shouldOpenQuickCapture(makeEvent({ key: 'C' }), idleContext)).toBe(true);
    });

    it('ignores other keys', () => {
        expect(shouldOpenQuickCapture(makeEvent({ key: 'x' }), idleContext)).toBe(false);
    });

    it.each([{ metaKey: true }, { ctrlKey: true }, { altKey: true }] as const)('stands down when a modifier is held (%o)', (modifier) => {
        expect(shouldOpenQuickCapture(makeEvent(modifier), idleContext)).toBe(false);
    });

    it('stands down when the event was already handled or is mid-IME-composition', () => {
        expect(shouldOpenQuickCapture(makeEvent({ defaultPrevented: true }), idleContext)).toBe(false);
        expect(shouldOpenQuickCapture(makeEvent({ isComposing: true }), idleContext)).toBe(false);
    });

    it('stands down while a modal is open', () => {
        expect(shouldOpenQuickCapture(makeEvent(), { ...idleContext, isModalOpen: true })).toBe(false);
    });

    it('stands down when typing in a text-entry surface', () => {
        expect(shouldOpenQuickCapture(makeEvent(), { ...idleContext, isEditableTarget: true })).toBe(false);
    });
});

// Tests run in a node environment with no DOM — stub a minimal HTMLElement so the
// `instanceof` branch inside isEditableEventTarget is exercised for real. The cast to
// EventTarget is the test-only bridge between the stub and the DOM-typed signature.
class FakeHTMLElement {
    tagName = 'DIV';
    isContentEditable = false;
}

const asTarget = (value: unknown) => value as EventTarget;

describe('isEditableEventTarget', () => {
    beforeEach(() => {
        vi.stubGlobal('HTMLElement', FakeHTMLElement);
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it.each(['INPUT', 'TEXTAREA', 'SELECT'] as const)('treats %s as a text-entry surface', (tagName) => {
        expect(isEditableEventTarget(asTarget(Object.assign(new FakeHTMLElement(), { tagName })))).toBe(true);
    });

    it('treats a contenteditable host as a text-entry surface', () => {
        expect(isEditableEventTarget(asTarget(Object.assign(new FakeHTMLElement(), { isContentEditable: true })))).toBe(true);
    });

    it('is false for a null target and for a plain element', () => {
        expect(isEditableEventTarget(null)).toBe(false);
        expect(isEditableEventTarget(asTarget(new FakeHTMLElement()))).toBe(false);
    });

    it('is false for a non-element target (e.g. window or document)', () => {
        expect(isEditableEventTarget(asTarget({}))).toBe(false);
    });
});
