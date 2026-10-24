// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { hasFocusMovedSince, ROW_BUTTON_ATTR, ROW_ITEM_ATTR, whenRowMounted } from '../lib/nextActionsRowDom';

function mount(html: string) {
    document.body.innerHTML = html;
}

function byId(id: string) {
    const element = document.getElementById(id);
    if (!element) throw new Error(`expected #${id} to be mounted`);
    return element;
}

afterEach(() => {
    document.body.innerHTML = '';
});

describe('hasFocusMovedSince', () => {
    it('is false while focus is still where the request was made', () => {
        mount('<div id="list" tabindex="0"></div>');
        const list = byId('list');
        list.focus();
        expect(hasFocusMovedSince(list)).toBe(false);
    });

    // Shift+Tab out of the list while a row was still mounting: the late row focus must not pull
    // the user back (keyboard-regions.spec "filter bar is one tab stop").
    it('is true once the user has moved focus to another element', () => {
        mount('<div id="list" tabindex="0"></div><input id="switch" />');
        const list = byId('list');
        list.focus();
        byId('switch').focus();
        expect(hasFocusMovedSince(list)).toBe(true);
    });

    it('is false when focus merely fell to the body (the focused node unmounted)', () => {
        mount('<div id="row" tabindex="0"></div>');
        const row = byId('row');
        row.focus();
        row.remove();
        expect(hasFocusMovedSince(row)).toBe(false);
    });
});

describe('whenRowMounted', () => {
    it('runs at once for a mounted row', () => {
        mount(`<div ${ROW_ITEM_ATTR}="a"><button ${ROW_BUTTON_ATTR}></button></div>`);
        let seen: string | null = null;
        whenRowMounted('a', (row) => {
            seen = row.getAttribute(ROW_ITEM_ATTR);
        });
        expect(seen).toBe('a');
    });
});
