import { describe, expect, it } from 'vitest';
import { isLinkActivation } from '../lib/notesPreviewLinks';

/**
 * vitest runs in a node environment, so the DOM walk itself is covered in Playwright
 * (item-editor-page-mode.spec.ts). These cases pin the contract around it: which selector is
 * queried, and how non-element targets are treated.
 */
describe('isLinkActivation', () => {
    it('queries specifically for href-bearing anchors, not bare <a> (anchor-name targets)', () => {
        const selectors: string[] = [];
        const target = {
            closest: (selector: string) => {
                selectors.push(selector);
                return null;
            },
        };
        expect(isLinkActivation(target as unknown as EventTarget)).toBe(false);
        expect(selectors).toEqual(['a[href]']);
    });

    it('is true only when the ancestor lookup finds a match', () => {
        expect(isLinkActivation({ closest: () => ({}) } as unknown as EventTarget)).toBe(true);
    });

    it('is false for null and for targets that cannot walk ancestors (text nodes, window)', () => {
        expect(isLinkActivation(null)).toBe(false);
        expect(isLinkActivation({} as EventTarget)).toBe(false);
    });
});
