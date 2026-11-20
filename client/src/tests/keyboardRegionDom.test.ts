// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { FIELD_PARKING_ATTR, isModalOpen, MODAL_POPUP_ATTR, parkingSpotOf, textControlIn } from '../lib/keyboardRegionDom';

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

function elementById(id: string) {
    const element = document.getElementById(id);
    if (!element) {
        throw new Error(`expected #${id}`);
    }
    return element;
}

describe('parkingSpotOf', () => {
    it('finds the enclosing field box', () => {
        mount(`<div id="box" ${FIELD_PARKING_ATTR}><span><input id="field" /></span></div>`);
        expect(parkingSpotOf(elementById('field'))).toBe(elementById('box'));
    });

    it('is null for a field with no box around it', () => {
        mount('<input id="field" />');
        expect(parkingSpotOf(elementById('field'))).toBeNull();
    });

    it('starts at the parent: an element that is itself a box parks on the box around it, never on itself', () => {
        mount(`<div id="outer" ${FIELD_PARKING_ATTR}><div id="inner" ${FIELD_PARKING_ATTR}></div></div>`);
        expect(parkingSpotOf(elementById('inner'))).toBe(elementById('outer'));
    });
});

describe('textControlIn', () => {
    it('finds a text input', () => {
        mount(`<div id="box" ${FIELD_PARKING_ATTR}><input id="field" /></div>`);
        expect(textControlIn(elementById('box'))).toBe(elementById('field'));
    });

    it('finds a textarea', () => {
        mount(`<div id="box" ${FIELD_PARKING_ATTR}><textarea id="field"></textarea></div>`);
        expect(textControlIn(elementById('box'))).toBe(elementById('field'));
    });

    it('finds a contenteditable surface (the CodeMirror notes editor)', () => {
        mount(`<div id="box" ${FIELD_PARKING_ATTR}><div class="cm-editor"><div id="field" contenteditable="true"></div></div></div>`);
        expect(textControlIn(elementById('box'))).toBe(elementById('field'));
    });

    it('skips a hidden input', () => {
        mount(`<div id="box" ${FIELD_PARKING_ATTR}><input type="hidden" /><input id="field" /></div>`);
        expect(textControlIn(elementById('box'))).toBe(elementById('field'));
    });

    it('is null for a box with no control yet (the editor chunk still loading)', () => {
        mount(`<div id="box" ${FIELD_PARKING_ATTR}></div>`);
        expect(textControlIn(elementById('box'))).toBeNull();
    });
});
