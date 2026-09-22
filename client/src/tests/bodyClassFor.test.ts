import { describe, expect, it } from 'vitest';
import { bodyClassFor } from '../components/itemEditor/ItemEditorBody';
import styles from '../components/itemEditor/ItemEditorBody.module.css';

// bodyClassFor is the single gate that keeps the weekly review's density modifier (tighter section
// gap, no notes-preview height floor, tighter notes ceiling) out of every other editor surface.

describe('bodyClassFor', () => {
    it('adds the review density modifier only for the review presentation', () => {
        expect(bodyClassFor('page', 'review')).toContain(styles.bodyReview);
        expect(bodyClassFor('page', 'edit')).not.toContain(styles.bodyReview);
    });

    it('keeps each chrome variant on its own base class', () => {
        expect(bodyClassFor('page', 'edit')).toBe(styles.body);
        expect(bodyClassFor('dialog', 'edit')).toBe(styles.body);
        expect(bodyClassFor('expand', 'edit')).toBe(styles.bodyExpand);
        expect(bodyClassFor('popover', 'edit')).toBe(styles.bodyPopover);
    });

    it('composes the modifier onto whichever chrome hosts the review', () => {
        // The review uses chrome="page" today, but the density must not be silently chrome-bound.
        const expanded = bodyClassFor('expand', 'review');
        expect(expanded).toContain(styles.bodyExpand);
        expect(expanded).toContain(styles.bodyReview);
    });
});
