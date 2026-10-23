import { describe, expect, it } from 'vitest';
import { EDITOR_KEY_SCOPE_ATTR, isParkedEditorFocus } from '../hooks/useEditorShortcuts';

/** A focus target as the predicate sees it: only its attributes matter. */
function targetWith(attributes: string[]) {
    return { hasAttribute: (name: string) => attributes.includes(name) };
}

describe('isParkedEditorFocus', () => {
    it('is true for the editor root itself (focus parked by a click into its empty space)', () => {
        expect(isParkedEditorFocus(targetWith([EDITOR_KEY_SCOPE_ATTR, 'tabindex']))).toBe(true);
    });

    it('is false for a control inside the editor, and for no target', () => {
        expect(isParkedEditorFocus(targetWith(['data-testid']))).toBe(false);
        expect(isParkedEditorFocus(null)).toBe(false);
    });
});
