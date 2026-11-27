import { describe, expect, it } from 'vitest';
import { hiddenEdges } from '../components/weeklyReview/useScrollToInlineEnd';

// The phone action bar fades the edge(s) beyond which buttons are scrolled out of view.
describe('hiddenEdges', () => {
    it('hides nothing when the row fits', () => {
        expect(hiddenEdges({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300 })).toEqual({ start: false, end: false });
    });

    it('marks the start when scrolled to the end of an overflowing row', () => {
        expect(hiddenEdges({ scrollLeft: 200, scrollWidth: 500, clientWidth: 300 })).toEqual({ start: true, end: false });
    });

    it('marks the end when scrolled to the start', () => {
        expect(hiddenEdges({ scrollLeft: 0, scrollWidth: 500, clientWidth: 300 })).toEqual({ start: false, end: true });
    });

    it('marks both edges in the middle', () => {
        expect(hiddenEdges({ scrollLeft: 100, scrollWidth: 500, clientWidth: 300 })).toEqual({ start: true, end: true });
    });

    it('ignores sub-pixel rounding at either end', () => {
        expect(hiddenEdges({ scrollLeft: 199.5, scrollWidth: 500, clientWidth: 300 })).toEqual({ start: true, end: false });
        expect(hiddenEdges({ scrollLeft: 0.5, scrollWidth: 500, clientWidth: 300 })).toEqual({ start: false, end: true });
    });
});
