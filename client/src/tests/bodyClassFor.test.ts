import { describe, expect, it } from 'vitest';
import { bodyClassFor } from '../components/itemEditor/ItemEditorBody';
import styles from '../components/itemEditor/ItemEditorBody.module.css';

// bodyClassFor is the single gate that keeps the weekly review's density modifier (tighter section
// gap, no notes-preview height floor, tighter notes ceiling) out of every other editor surface.

describe('bodyClassFor', () => {
    it('adds the review density modifier only for the review presentation', () => {
        expect(bodyClassFor('review')).toContain(styles.bodyReview);
        expect(bodyClassFor('edit')).not.toContain(styles.bodyReview);
    });

    it('keeps the base body class under the review modifier', () => {
        expect(bodyClassFor('edit')).toBe(styles.body);
        expect(bodyClassFor('review')).toContain(styles.body);
    });
});
