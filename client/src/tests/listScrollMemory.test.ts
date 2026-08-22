import { afterEach, describe, expect, it } from 'vitest';
import {
    ANCHOR_AGREEMENT_TOLERANCE_PX,
    consensusScrollTop,
    MAX_SAVED_ANCHORS,
    pickVisibleAnchors,
    readFreshListScrollEntry,
    resetListScrollMemory,
    SCROLL_STICKY_WINDOW_MS,
    saveListScrollEntry,
    scrollTopForAnchor,
} from '../lib/listScrollMemory';

afterEach(() => {
    resetListScrollMemory();
});

describe('listScrollMemory store', () => {
    it('returns a saved entry within the sticky window', () => {
        const entry = { scrollTop: 480, anchors: [{ id: 'a', offset: 12 }], savedAtMs: 1_000 };
        saveListScrollEntry('/next-actions', entry);
        expect(readFreshListScrollEntry('/next-actions', 1_000 + SCROLL_STICKY_WINDOW_MS)).toEqual(entry);
    });

    it('drops an entry once the sticky window has lapsed', () => {
        saveListScrollEntry('/next-actions', { scrollTop: 480, anchors: [], savedAtMs: 1_000 });
        expect(readFreshListScrollEntry('/next-actions', 1_001 + SCROLL_STICKY_WINDOW_MS)).toBeNull();
        // The stale entry is deleted, not just hidden — a later in-window read still misses.
        expect(readFreshListScrollEntry('/next-actions', 1_000)).toBeNull();
    });

    it('keys entries by full location, so different filters restore independently', () => {
        saveListScrollEntry('/next-actions', { scrollTop: 100, anchors: [], savedAtMs: 1_000 });
        saveListScrollEntry('/next-actions?energy=low', { scrollTop: 900, anchors: [], savedAtMs: 1_000 });
        expect(readFreshListScrollEntry('/next-actions', 1_000)?.scrollTop).toBe(100);
        expect(readFreshListScrollEntry('/next-actions?energy=low', 1_000)?.scrollTop).toBe(900);
    });

    it('returns null for a location never saved', () => {
        expect(readFreshListScrollEntry('/someday', 1_000)).toBeNull();
    });
});

describe('pickVisibleAnchors', () => {
    const viewport = { top: 0, bottom: 600 };
    const rows = [
        { id: 'a', top: -80, bottom: -20 },
        { id: 'b', top: -20, bottom: 40 },
        { id: 'c', top: 40, bottom: 100 },
    ];

    it('collects every row at least partially inside the viewport, topmost first', () => {
        expect(pickVisibleAnchors(viewport, rows)).toEqual([
            { id: 'b', offset: -20 },
            { id: 'c', offset: 40 },
        ]);
    });

    it('records a positive offset when a row sits fully below the container top', () => {
        expect(pickVisibleAnchors({ top: -50, bottom: 600 }, rows)).toEqual([
            { id: 'a', offset: -30 },
            { id: 'b', offset: 30 },
            { id: 'c', offset: 90 },
        ]);
    });

    it('excludes rows below the container bottom, which are not visible', () => {
        const withOffscreenRow = [
            { id: 'onscreen', top: 0, bottom: 60 },
            { id: 'offscreen', top: 800, bottom: 860 },
        ];
        expect(pickVisibleAnchors(viewport, withOffscreenRow)).toEqual([{ id: 'onscreen', offset: 0 }]);
    });

    it('keeps a row straddling the container bottom (partially visible)', () => {
        expect(pickVisibleAnchors(viewport, [{ id: 'straddler', top: 590, bottom: 650 }])).toEqual([{ id: 'straddler', offset: 590 }]);
    });

    it('caps the anchor count at MAX_SAVED_ANCHORS, keeping the topmost rows', () => {
        const manyRows = Array.from({ length: MAX_SAVED_ANCHORS + 5 }, (_, i) => ({ id: `row-${i}`, top: i * 60, bottom: i * 60 + 60 }));
        const anchors = pickVisibleAnchors({ top: 0, bottom: 2_000 }, manyRows);
        expect(anchors.map((anchor) => anchor.id)).toEqual(Array.from({ length: MAX_SAVED_ANCHORS }, (_, i) => `row-${i}`));
    });

    it('applies the cap to the visible set — rows scrolled past do not consume cap slots', () => {
        // 3 rows above the viewport + 14 visible: all 12 slots must go to visible rows.
        const manyRows = Array.from({ length: MAX_SAVED_ANCHORS + 5 }, (_, i) => ({ id: `row-${i}`, top: (i - 3) * 60, bottom: (i - 3) * 60 + 60 }));
        const anchors = pickVisibleAnchors({ top: 0, bottom: 2_000 }, manyRows);
        expect(anchors.map((anchor) => anchor.id)).toEqual(Array.from({ length: MAX_SAVED_ANCHORS }, (_, i) => `row-${i + 3}`));
    });

    it('returns no anchors when there are no rows', () => {
        expect(pickVisibleAnchors(viewport, [])).toEqual([]);
    });

    it('returns no anchors when every row is scrolled past', () => {
        expect(pickVisibleAnchors({ top: 200, bottom: 800 }, rows)).toEqual([]);
    });
});

describe('scrollTopForAnchor', () => {
    it('is a no-op when the anchor already sits at its saved offset', () => {
        expect(scrollTopForAnchor({ currentScrollTop: 500, containerTop: 64 }, 44, -20)).toBe(500);
    });

    it('scrolls down when the anchor now renders lower than it was saved (rows removed above)', () => {
        // Anchor saved 20px above the container top, now found 100px below it → need to scroll 120px further.
        expect(scrollTopForAnchor({ currentScrollTop: 0, containerTop: 64 }, 164, -20)).toBe(120);
    });

    it('scrolls up when the anchor now renders higher than it was saved (rows added above were removed)', () => {
        expect(scrollTopForAnchor({ currentScrollTop: 300, containerTop: 64 }, 24, 60)).toBe(200);
    });
});

describe('consensusScrollTop', () => {
    it('returns null with no targets (fall back to the raw pixel offset)', () => {
        expect(consensusScrollTop([], 500)).toBeNull();
    });

    it('follows the lone surviving anchor', () => {
        expect(consensusScrollTop([730], 500)).toBe(730);
    });

    it('ignores the one row an edit moved in the sort and sticks with the agreeing majority', () => {
        // Four neighbors agree (within tolerance) around ~2000; the edited row now computes 5400.
        expect(consensusScrollTop([2000, 2004, 1998, 2010, 5400], 2000)).toBe(2002);
    });

    it('picks the larger cluster even when the outlier sits closer to the saved pixel offset', () => {
        expect(consensusScrollTop([2400, 2404, 2001], 2000)).toBe(2402);
    });

    it('breaks a tie between lone disagreeing anchors toward the saved pixel offset', () => {
        expect(consensusScrollTop([90, 2010], 2000)).toBe(2010);
    });

    it('does not let a chain of near-neighbors masquerade as one agreeing cluster', () => {
        // 0..90 spans ~3 tolerances: no run of 3+ fits inside one tolerance, so the size-2
        // runs tie and the one whose median matches the saved offset wins.
        expect(consensusScrollTop([0, 30, 60, 90], 45)).toBe(45);
    });

    it('counts a target exactly at the tolerance as agreeing (cluster median wins)', () => {
        expect(consensusScrollTop([0, ANCHOR_AGREEMENT_TOLERANCE_PX], 0)).toBe(ANCHOR_AGREEMENT_TOLERANCE_PX / 2);
    });

    it('counts a target one px past the tolerance as disagreeing', () => {
        expect(consensusScrollTop([0, ANCHOR_AGREEMENT_TOLERANCE_PX + 1], 0)).toBe(0);
    });

    it('is independent of input order', () => {
        expect(consensusScrollTop([90, 110], 100)).toBe(100);
        expect(consensusScrollTop([110, 90], 100)).toBe(100);
    });

    it('resolves an exact-distance tie deterministically toward the lower target', () => {
        expect(consensusScrollTop([60, 140], 100)).toBe(60);
        expect(consensusScrollTop([140, 60], 100)).toBe(60);
    });

    it('follows the larger half when the moved row splits the anchors into two blocks', () => {
        // Rows above the moved row keep their target; rows below shift up by one row height.
        expect(consensusScrollTop([2000, 2000, 2000, 1940, 1940, 1940, 1940], 2000)).toBe(1940);
    });

    it('takes the middle target of an odd-sized cluster', () => {
        expect(consensusScrollTop([10, 12, 14, 16, 18], 0)).toBe(14);
    });

    it('interpolates between the two middle targets of an even-sized cluster', () => {
        expect(consensusScrollTop([10, 12, 14, 16], 0)).toBe(13);
    });
});
