import { afterEach, describe, expect, it } from 'vitest';
import {
    pickTopVisibleAnchor,
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
        const entry = { scrollTop: 480, anchor: { id: 'a', offset: 12 }, savedAtMs: 1_000 };
        saveListScrollEntry('/next-actions', entry);
        expect(readFreshListScrollEntry('/next-actions', 1_000 + SCROLL_STICKY_WINDOW_MS)).toEqual(entry);
    });

    it('drops an entry once the sticky window has lapsed', () => {
        saveListScrollEntry('/next-actions', { scrollTop: 480, anchor: null, savedAtMs: 1_000 });
        expect(readFreshListScrollEntry('/next-actions', 1_001 + SCROLL_STICKY_WINDOW_MS)).toBeNull();
        // The stale entry is deleted, not just hidden — a later in-window read still misses.
        expect(readFreshListScrollEntry('/next-actions', 1_000)).toBeNull();
    });

    it('keys entries by full location, so different filters restore independently', () => {
        saveListScrollEntry('/next-actions', { scrollTop: 100, anchor: null, savedAtMs: 1_000 });
        saveListScrollEntry('/next-actions?energy=low', { scrollTop: 900, anchor: null, savedAtMs: 1_000 });
        expect(readFreshListScrollEntry('/next-actions', 1_000)?.scrollTop).toBe(100);
        expect(readFreshListScrollEntry('/next-actions?energy=low', 1_000)?.scrollTop).toBe(900);
    });

    it('returns null for a location never saved', () => {
        expect(readFreshListScrollEntry('/someday', 1_000)).toBeNull();
    });
});

describe('pickTopVisibleAnchor', () => {
    const rows = [
        { id: 'a', top: -80, bottom: -20 },
        { id: 'b', top: -20, bottom: 40 },
        { id: 'c', top: 40, bottom: 100 },
    ];

    it('picks the first row whose bottom is below the container top', () => {
        expect(pickTopVisibleAnchor(0, rows)).toEqual({ id: 'b', offset: -20 });
    });

    it('records a positive offset when the anchor sits fully below the container top', () => {
        expect(pickTopVisibleAnchor(-50, rows)).toEqual({ id: 'a', offset: -30 });
    });

    it('returns null when there are no rows', () => {
        expect(pickTopVisibleAnchor(0, [])).toBeNull();
    });

    it('returns null when every row is scrolled past', () => {
        expect(pickTopVisibleAnchor(200, rows)).toBeNull();
    });
});

describe('scrollTopForAnchor', () => {
    it('is a no-op when the anchor already sits at its saved offset', () => {
        expect(scrollTopForAnchor(500, 64, 44, -20)).toBe(500);
    });

    it('scrolls down when the anchor now renders lower than it was saved (rows removed above)', () => {
        // Anchor saved 20px above the container top, now found 100px below it → need to scroll 120px further.
        expect(scrollTopForAnchor(0, 64, 164, -20)).toBe(120);
    });

    it('scrolls up when the anchor now renders higher than it was saved (rows added above were removed)', () => {
        expect(scrollTopForAnchor(300, 64, 24, 60)).toBe(200);
    });
});
