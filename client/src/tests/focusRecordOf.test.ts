// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { focusRecordOf } from '../components/weeklyReview/useTransitionFocusRestore';

afterEach(() => {
    document.body.innerHTML = '';
});

function mount(html: string) {
    document.body.innerHTML = html;
}

function byId(id: string) {
    const element = document.getElementById(id);
    if (!element) throw new Error(`expected #${id}`);
    return element;
}

describe('focusRecordOf', () => {
    it('records a focused control by its own test id', () => {
        mount('<div data-testid="focusStage"><button id="target" data-testid="focusKeep">Looks good</button></div>');
        expect(focusRecordOf(byId('target'))?.testId).toBe('focusKeep');
    });

    it('records the closest test-id ancestor for a control without one', () => {
        mount('<div data-testid="focusStage"><button id="target">Unnamed</button></div>');
        expect(focusRecordOf(byId('target'))?.testId).toBe('focusStage');
    });

    it('records a text field by its container even when the field carries a test id', () => {
        // Text-field focus is a disconnection sentinel, never a restore target: restoring into the
        // next card's field would let Space type instead of reaching the bar primary.
        mount(`
            <div data-testid="focusStage">
                <textarea id="title" data-testid="itemEditorTitle"></textarea>
                <input id="time" type="number" data-testid="timeEstimateInput" />
            </div>`);
        expect(focusRecordOf(byId('title'))?.testId).toBe('focusStage');
        expect(focusRecordOf(byId('time'))?.testId).toBe('focusStage');
    });

    it('treats a content-editable editor (the notes editor) as a text field', () => {
        mount('<div data-testid="focusStage"><div id="notes" contenteditable="" data-testid="notesEditor"></div></div>');
        expect(focusRecordOf(byId('notes'))?.testId).toBe('focusStage');
    });

    it('records nothing outside any test-id scope', () => {
        mount('<input id="target" data-testid="loneInput" />');
        expect(focusRecordOf(byId('target'))).toBeNull();
    });
});
