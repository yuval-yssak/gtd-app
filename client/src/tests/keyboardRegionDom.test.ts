// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { isModalOpen, MODAL_POPUP_ATTR } from '../lib/keyboardRegionDom';

function mount(html: string) {
    document.body.innerHTML = html;
}

afterEach(() => {
    document.body.innerHTML = '';
});

describe('isModalOpen', () => {
    it('is false on a page with no popup', () => {
        mount('<main><button>Edit</button></main>');
        expect(isModalOpen()).toBe(false);
    });

    describe('MUI modals (until the last MUI dialog is gone)', () => {
        it('is true while an MUI modal root is shown', () => {
            mount('<div class="MuiModal-root"><div role="dialog"></div></div>');
            expect(isModalOpen()).toBe(true);
        });

        it('ignores a keep-mounted MUI modal that is aria-hidden while closed', () => {
            mount('<div class="MuiModal-root" aria-hidden="true"><nav></nav></div>');
            expect(isModalOpen()).toBe(false);
        });
    });

    describe('design-system popups', () => {
        it('is true while a marked popup is open', () => {
            mount(`<div ${MODAL_POPUP_ATTR} data-open role="dialog"></div>`);
            expect(isModalOpen()).toBe(true);
        });

        it('is false while a marked popup is closing (Base UI drops data-open first)', () => {
            mount(`<div ${MODAL_POPUP_ATTR} data-closed role="dialog"></div>`);
            expect(isModalOpen()).toBe(false);
        });

        it('ignores an open popup that is not marked (a tooltip must not block shortcuts)', () => {
            mount('<div data-open role="tooltip">Edit (e)</div>');
            expect(isModalOpen()).toBe(false);
        });
    });
});
