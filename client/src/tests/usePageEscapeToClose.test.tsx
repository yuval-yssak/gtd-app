// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePageEscapeToClose } from '../hooks/usePageEscapeToClose';
import { MODAL_POPUP_ATTR } from '../lib/keyboardRegionDom';

function EscapeHost({ enabled, onEscape }: { enabled: boolean; onEscape: () => void }) {
    usePageEscapeToClose({ enabled, onEscape });
    return null;
}

function mountPopup(attributes: Record<string, string>) {
    const popup = document.createElement('div');
    for (const [name, value] of Object.entries(attributes)) {
        popup.setAttribute(name, value);
    }
    document.body.append(popup);
    return popup;
}

function pressEscape() {
    fireEvent.keyDown(document, { key: 'Escape' });
}

afterEach(() => {
    cleanup();
    document.body.replaceChildren();
});

describe('usePageEscapeToClose', () => {
    it('leaves the page on Escape when no popup is open', () => {
        const onEscape = vi.fn();
        render(<EscapeHost enabled onEscape={onEscape} />);
        pressEscape();
        expect(onEscape).toHaveBeenCalledTimes(1);
    });

    it('stands down while a design-system popup is open, so Escape closes the popup first', () => {
        const onEscape = vi.fn();
        render(<EscapeHost enabled onEscape={onEscape} />);
        mountPopup({ [MODAL_POPUP_ATTR]: '', 'data-open': '' });
        pressEscape();
        expect(onEscape).not.toHaveBeenCalled();
    });

    it('ignores a popup that is mounted but closed', () => {
        const onEscape = vi.fn();
        render(<EscapeHost enabled onEscape={onEscape} />);
        mountPopup({ [MODAL_POPUP_ATTR]: '', 'data-closed': '' });
        pressEscape();
        expect(onEscape).toHaveBeenCalledTimes(1);
    });

    it('does nothing while disabled', () => {
        const onEscape = vi.fn();
        render(<EscapeHost enabled={false} onEscape={onEscape} />);
        pressEscape();
        expect(onEscape).not.toHaveBeenCalled();
    });
});
