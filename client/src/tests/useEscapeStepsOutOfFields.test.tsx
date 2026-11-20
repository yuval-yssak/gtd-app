// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useEscapeStepsOutOfFields } from '../hooks/useEscapeStepsOutOfFields';
import { FIELD_PARKING_ATTR, MODAL_POPUP_ATTR } from '../lib/keyboardRegionDom';

function StepOutHost() {
    useEscapeStepsOutOfFields();
    return null;
}

function mountFocused(markup: string) {
    const host = document.createElement('div');
    host.innerHTML = markup;
    document.body.append(host);
    const field = host.firstElementChild;
    if (!(field instanceof HTMLElement)) {
        throw new Error('expected an element');
    }
    field.focus();
    return field;
}

/** A design-system field box: a focusable parking spot around its input. */
function mountParkedField() {
    const box = document.createElement('div');
    box.setAttribute(FIELD_PARKING_ATTR, '');
    box.tabIndex = -1;
    const input = document.createElement('input');
    box.append(input);
    document.body.append(box);
    input.focus();
    return { box, input };
}

function mountOpenModal() {
    const popup = document.createElement('div');
    popup.setAttribute(MODAL_POPUP_ATTR, '');
    popup.setAttribute('data-open', '');
    document.body.append(popup);
}

afterEach(() => {
    cleanup();
    document.body.replaceChildren();
});

describe('useEscapeStepsOutOfFields', () => {
    it('blurs a focused text input on Escape', () => {
        render(<StepOutHost />);
        const input = mountFocused('<input type="text" />');
        fireEvent.keyDown(input, { key: 'Escape' });
        expect(document.activeElement).not.toBe(input);
    });

    it('blurs a focused textarea on Escape', () => {
        render(<StepOutHost />);
        const textarea = mountFocused('<textarea></textarea>');
        fireEvent.keyDown(textarea, { key: 'Escape' });
        expect(document.activeElement).not.toBe(textarea);
    });

    it('leaves a focused checkbox alone — it is not a text field', () => {
        render(<StepOutHost />);
        const checkbox = mountFocused('<input type="checkbox" />');
        fireEvent.keyDown(checkbox, { key: 'Escape' });
        expect(document.activeElement).toBe(checkbox);
    });

    it('keeps focus when the field claimed Escape itself', () => {
        render(<StepOutHost />);
        const input = mountFocused('<input type="text" />');
        input.addEventListener('keydown', (event) => event.preventDefault());
        fireEvent.keyDown(input, { key: 'Escape' });
        expect(document.activeElement).toBe(input);
    });

    it('keeps focus inside an open modal, whose own Escape closes it', () => {
        render(<StepOutHost />);
        mountOpenModal();
        const input = mountFocused('<input type="text" />');
        fireEvent.keyDown(input, { key: 'Escape' });
        expect(document.activeElement).toBe(input);
    });

    it('stops listening once unmounted', () => {
        const { unmount } = render(<StepOutHost />);
        unmount();
        const input = mountFocused('<input type="text" />');
        fireEvent.keyDown(input, { key: 'Escape' });
        expect(document.activeElement).toBe(input);
    });

    it('keeps focus on any other key', () => {
        render(<StepOutHost />);
        const input = mountFocused('<input type="text" />');
        fireEvent.keyDown(input, { key: 'a' });
        expect(document.activeElement).toBe(input);
    });

    it('parks focus on the field box when the field has one, instead of dropping it on the page', () => {
        render(<StepOutHost />);
        const { box, input } = mountParkedField();
        fireEvent.keyDown(input, { key: 'Escape' });
        expect(document.activeElement).toBe(box);
    });

    it('Enter on a parked field box steps back into its field', () => {
        render(<StepOutHost />);
        const { box, input } = mountParkedField();
        fireEvent.keyDown(input, { key: 'Escape' });
        fireEvent.keyDown(box, { key: 'Enter' });
        expect(document.activeElement).toBe(input);
    });

    it('Cmd+Enter on a parked field box stays parked', () => {
        render(<StepOutHost />);
        const { box, input } = mountParkedField();
        fireEvent.keyDown(input, { key: 'Escape' });
        fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
        expect(document.activeElement).toBe(box);
    });

    it('lets Enter through when the parked box has no control to step into', () => {
        render(<StepOutHost />);
        const box = document.createElement('div');
        box.setAttribute(FIELD_PARKING_ATTR, '');
        box.tabIndex = -1;
        document.body.append(box);
        box.focus();
        const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        box.dispatchEvent(enter);
        expect(enter.defaultPrevented).toBe(false);
    });
});
