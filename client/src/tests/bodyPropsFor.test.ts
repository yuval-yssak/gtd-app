import { describe, expect, it } from 'vitest';
import { bodyPropsFor } from '../components/itemEditor/ItemEditorBody';
import styles from '../components/itemEditor/ItemEditorBody.module.css';

// bodyPropsFor is the single gate that keeps the weekly review's density modifier (tighter section
// gap, no notes-preview height floor, tighter notes ceiling) out of every other editor surface.

describe('bodyPropsFor', () => {
    it('flags the review density modifier only for the review presentation', () => {
        expect(bodyPropsFor('review')['data-review']).toBe(true);
        expect(bodyPropsFor('edit')['data-review']).toBeUndefined();
    });

    it('keeps the base body class either way', () => {
        expect(bodyPropsFor('edit').className).toBe(styles.body);
        expect(bodyPropsFor('review').className).toBe(styles.body);
    });
});
