import { describe, expect, it } from 'vitest';
import {
    ANCHOR_CORROBORATION_FRAMES,
    INITIAL_RESTORE_SETTLING,
    nextRestoreSettling,
    RESTORE_RETRY_FRAMES,
    RESTORE_SETTLE_FRAMES,
    type RestoreSettling,
    restoreTargetForFrame,
} from '../hooks/useListScrollRestoration';
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

describe('nextRestoreSettling', () => {
    const corroborated = (target: number) => ({ target, shouldKeepWatching: false });

    // The first corroborated frame can be measured against ESTIMATED heights of rows a windowed
    // list has not mounted yet — when they mount, the anchors move. Settling needs the target to
    // hold, not just to exist once.
    it('does not settle on the first corroborated frame', () => {
        expect(nextRestoreSettling(INITIAL_RESTORE_SETTLING, corroborated(1_554)).isSettled).toBe(false);
    });

    it('settles once the corroborated target holds for the settle window', () => {
        const settled = Array.from({ length: RESTORE_SETTLE_FRAMES }).reduce(
            (settling: RestoreSettling) => nextRestoreSettling(settling, corroborated(1_554)),
            nextRestoreSettling(INITIAL_RESTORE_SETTLING, corroborated(1_554)),
        );
        expect(settled.isSettled).toBe(true);
    });

    it('restarts the window when the anchors move after rows above them mount', () => {
        const holding = nextRestoreSettling(nextRestoreSettling(INITIAL_RESTORE_SETTLING, corroborated(1_554)), corroborated(1_554));
        const moved = nextRestoreSettling(holding, corroborated(1_820));
        expect(moved).toEqual({ windowTarget: 1_820, stableFrames: 0, isSettled: false });
    });

    it('treats sub-pixel jitter as holding', () => {
        const first = nextRestoreSettling(INITIAL_RESTORE_SETTLING, corroborated(1_554));
        expect(nextRestoreSettling(first, corroborated(1_554.5)).stableFrames).toBe(1);
    });

    // Measured from the window's FIRST frame: 1px per frame stays under the jitter allowance
    // each step but adds up, and a target still creeping has not landed.
    it('does not count a slow creep as holding', () => {
        const crept = [1_555, 1_556, 1_557].reduce<ReturnType<typeof nextRestoreSettling>>(
            (settling, target) => nextRestoreSettling(settling, corroborated(target)),
            nextRestoreSettling(INITIAL_RESTORE_SETTLING, corroborated(1_554)),
        );
        expect(crept.isSettled).toBe(false);
    });

    it('never settles while the frame decision still wants to keep watching', () => {
        const watching = nextRestoreSettling(INITIAL_RESTORE_SETTLING, { target: 2_000, shouldKeepWatching: true });
        expect(watching).toEqual({ windowTarget: 2_000, stableFrames: 0, isSettled: false });
    });
});
