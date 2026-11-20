import { describe, expect, it } from 'vitest';
import { shouldHandlePageEscape, shouldStepIntoField, shouldStepOutOfField } from '../lib/escapeStepOut';

describe('shouldStepOutOfField', () => {
    const escapeInField = { key: 'Escape', defaultPrevented: false, isComposing: false };
    const inTextField = { isEditableTarget: true, isModalOpen: false };

    it('steps out of a text field on a clean Escape', () => {
        expect(shouldStepOutOfField(escapeInField, inTextField)).toBe(true);
    });

    it('ignores every other key', () => {
        expect(shouldStepOutOfField({ ...escapeInField, key: 'Enter' }, inTextField)).toBe(false);
    });

    it('does nothing outside a text field — Escape there belongs to the page', () => {
        expect(shouldStepOutOfField(escapeInField, { ...inTextField, isEditableTarget: false })).toBe(false);
    });

    it('stands down when the field claimed Escape itself (closing its own popup, committing a value)', () => {
        expect(shouldStepOutOfField({ ...escapeInField, defaultPrevented: true }, inTextField)).toBe(false);
    });

    it('stands down during IME composition, where Escape cancels the composition', () => {
        expect(shouldStepOutOfField({ ...escapeInField, isComposing: true }, inTextField)).toBe(false);
    });

    it('stands down inside an open modal, whose Escape closes the modal', () => {
        expect(shouldStepOutOfField(escapeInField, { ...inTextField, isModalOpen: true })).toBe(false);
    });
});

describe('shouldHandlePageEscape', () => {
    const cleanEvent = { defaultPrevented: false, isComposing: false };
    const onPage = { isModalOpen: false, isEditableTarget: false };

    it('handles a clean Escape when no modal is open', () => {
        expect(shouldHandlePageEscape(cleanEvent, onPage)).toBe(true);
    });

    it('stands down when the event was already claimed (defaultPrevented)', () => {
        expect(shouldHandlePageEscape({ ...cleanEvent, defaultPrevented: true }, onPage)).toBe(false);
    });

    it('stands down during IME composition', () => {
        expect(shouldHandlePageEscape({ ...cleanEvent, isComposing: true }, onPage)).toBe(false);
    });

    it('stands down while a modal popup is open', () => {
        expect(shouldHandlePageEscape(cleanEvent, { ...onPage, isModalOpen: true })).toBe(false);
    });

    it('stands down when Escape came from a text field — the first Escape only steps out of the field', () => {
        expect(shouldHandlePageEscape(cleanEvent, { ...onPage, isEditableTarget: true })).toBe(false);
    });
});

describe('shouldStepIntoField', () => {
    const enter = { key: 'Enter', defaultPrevented: false, isComposing: false, altKey: false, shiftKey: false, metaKey: false, ctrlKey: false };
    const parked = { isParkedOnField: true, isModalOpen: false };

    it('steps back into the field on Enter while focus is parked on its box', () => {
        expect(shouldStepIntoField(enter, parked)).toBe(true);
    });

    it('ignores Enter anywhere else', () => {
        expect(shouldStepIntoField(enter, { ...parked, isParkedOnField: false })).toBe(false);
    });

    it('ignores every other key', () => {
        expect(shouldStepIntoField({ ...enter, key: 'g' }, parked)).toBe(false);
    });

    it('ignores Enter with a modifier — Cmd/Ctrl+Enter saves the editor', () => {
        expect(shouldStepIntoField({ ...enter, metaKey: true }, parked)).toBe(false);
        expect(shouldStepIntoField({ ...enter, ctrlKey: true }, parked)).toBe(false);
        expect(shouldStepIntoField({ ...enter, shiftKey: true }, parked)).toBe(false);
        expect(shouldStepIntoField({ ...enter, altKey: true }, parked)).toBe(false);
    });

    it('stands down when something else claimed the key', () => {
        expect(shouldStepIntoField({ ...enter, defaultPrevented: true }, parked)).toBe(false);
    });

    it('stands down under an open modal', () => {
        expect(shouldStepIntoField(enter, { ...parked, isModalOpen: true })).toBe(false);
    });
});
