import { describe, expect, it } from 'vitest';
import { ANCHOR_CORROBORATION_FRAMES, RESTORE_RETRY_FRAMES, restoreTargetForFrame } from '../hooks/useListScrollRestoration';
import type { ListScrollEntry } from '../lib/listScrollMemory';

const SAVED_SCROLL_TOP = 2_000;

function entryWithAnchors(anchorCount: number): ListScrollEntry {
    return {
        scrollTop: SAVED_SCROLL_TOP,
        anchors: Array.from({ length: anchorCount }, (_, i) => ({ id: `row-${i}`, offset: i * 60 })),
        savedAtMs: 1_000,
    };
}

const framesLeftAfter = (framesUsed: number) => RESTORE_RETRY_FRAMES - framesUsed;

describe('restoreTargetForFrame', () => {
    it('holds at the raw pixel offset while a lone anchor awaits corroboration', () => {
        // The lone mounted anchor may be exactly the row the edit moved — don't follow it yet.
        expect(restoreTargetForFrame(entryWithAnchors(5), [5_400], framesLeftAfter(0))).toEqual({
            target: SAVED_SCROLL_TOP,
            shouldKeepWatching: true,
        });
    });

    it('still holds on the last frame inside the corroboration budget', () => {
        expect(restoreTargetForFrame(entryWithAnchors(5), [5_400], framesLeftAfter(ANCHOR_CORROBORATION_FRAMES - 1))).toEqual({
            target: SAVED_SCROLL_TOP,
            shouldKeepWatching: true,
        });
    });

    it('acts on a lone surviving anchor once the corroboration budget is spent, but keeps watching', () => {
        expect(restoreTargetForFrame(entryWithAnchors(5), [5_400], framesLeftAfter(ANCHOR_CORROBORATION_FRAMES))).toEqual({
            target: 5_400,
            shouldKeepWatching: true,
        });
    });

    it('keeps watching for anchors after the corroboration budget expires', () => {
        const entry = entryWithAnchors(5);
        // Budget spent with nothing mounted — act on the fallback, but do NOT stop looking,
        // or a windowed list that mounts its rows late never re-anchors precisely.
        expect(restoreTargetForFrame(entry, [], framesLeftAfter(ANCHOR_CORROBORATION_FRAMES))).toEqual({
            target: SAVED_SCROLL_TOP,
            shouldKeepWatching: true,
        });
        // Rows mounted at frame 25 — the late consensus supersedes the fallback and settles the chain.
        expect(restoreTargetForFrame(entry, [2_400, 2_404], framesLeftAfter(25))).toEqual({
            target: 2_402,
            shouldKeepWatching: false,
        });
    });

    it('behaves like any post-budget frame when the retry budget is exhausted', () => {
        expect(restoreTargetForFrame(entryWithAnchors(5), [5_400], 0)).toEqual({
            target: 5_400,
            shouldKeepWatching: true,
        });
    });

    it('repositions and settles immediately once a second anchor corroborates', () => {
        expect(restoreTargetForFrame(entryWithAnchors(5), [2_004, 2_008], framesLeftAfter(0))).toEqual({
            target: 2_006,
            shouldKeepWatching: false,
        });
    });

    it('outvotes the one moved row when the others agree', () => {
        expect(restoreTargetForFrame(entryWithAnchors(5), [1_998, 2_004, 5_400], framesLeftAfter(0))).toEqual({
            target: 2_001,
            shouldKeepWatching: false,
        });
    });

    it('follows a single saved anchor immediately (nothing to corroborate against)', () => {
        expect(restoreTargetForFrame(entryWithAnchors(1), [1_234], framesLeftAfter(0))).toEqual({
            target: 1_234,
            shouldKeepWatching: false,
        });
    });

    it('uses the pixel fallback without waiting or watching when the entry saved no anchors', () => {
        expect(restoreTargetForFrame(entryWithAnchors(0), [], framesLeftAfter(0))).toEqual({
            target: SAVED_SCROLL_TOP,
            shouldKeepWatching: false,
        });
    });
});
