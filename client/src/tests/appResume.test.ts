/**
 * App-resume detection: the missing sync trigger for an installed PWA, which is frozen while
 * backgrounded and returns with no boot, no `online` transition and a dead SSE socket.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAwayLongEnoughToDoubtData, LONG_AWAY_MS, setLongAwayMs, subscribeToAppResume } from '../lib/appResume';

// The node test env has no document/window — EventTarget stubs so the listener wiring is
// exercised rather than skipped (same approach as tests/dayClock.test.ts).
function installDomEventTargetStub(globalName: 'document' | 'window'): EventTarget {
    const stub = new EventTarget();
    Object.defineProperty(globalThis, globalName, { value: stub, configurable: true, writable: true });
    return stub;
}
const documentStub = installDomEventTargetStub('document');
const windowStub = installDomEventTargetStub('window');

/** document.visibilityState is read by the handler; drive it per test. */
function setVisibility(state: 'visible' | 'hidden'): void {
    Object.defineProperty(documentStub, 'visibilityState', { value: state, configurable: true });
}

let unsubscribe: (() => void) | undefined;

beforeEach(() => {
    setVisibility('visible');
});

afterEach(() => {
    unsubscribe?.();
    unsubscribe = undefined;
});

describe('subscribeToAppResume', () => {
    it('fires on the visible edge of visibilitychange', () => {
        const onResume = vi.fn();
        unsubscribe = subscribeToAppResume(onResume);

        documentStub.dispatchEvent(new Event('visibilitychange'));

        expect(onResume).toHaveBeenCalledTimes(1);
    });

    it('does not fire when the app is being hidden', () => {
        const onResume = vi.fn();
        unsubscribe = subscribeToAppResume(onResume);

        setVisibility('hidden');
        documentStub.dispatchEvent(new Event('visibilitychange'));

        expect(onResume).not.toHaveBeenCalled();
    });

    it('fires on pageshow — iOS restores a bfcached PWA without a visibilitychange', () => {
        const onResume = vi.fn();
        unsubscribe = subscribeToAppResume(onResume);

        windowStub.dispatchEvent(new Event('pageshow'));

        expect(onResume).toHaveBeenCalledTimes(1);
    });

    it('collapses the visibilitychange + pageshow pair a single resume emits', () => {
        const onResume = vi.fn();
        let clock = 1_000;
        unsubscribe = subscribeToAppResume(onResume, () => clock);

        documentStub.dispatchEvent(new Event('visibilitychange'));
        clock += 50;
        windowStub.dispatchEvent(new Event('pageshow'));

        expect(onResume).toHaveBeenCalledTimes(1);
    });

    it('fires again for a genuinely separate resume once the quiet period has passed', () => {
        const onResume = vi.fn();
        let clock = 1_000;
        unsubscribe = subscribeToAppResume(onResume, () => clock);

        documentStub.dispatchEvent(new Event('visibilitychange'));
        clock += 5_000;
        documentStub.dispatchEvent(new Event('visibilitychange'));

        expect(onResume).toHaveBeenCalledTimes(2);
    });

    it('stops firing after unsubscribe', () => {
        const onResume = vi.fn();
        const stop = subscribeToAppResume(onResume);

        stop();
        documentStub.dispatchEvent(new Event('visibilitychange'));
        windowStub.dispatchEvent(new Event('pageshow'));

        expect(onResume).not.toHaveBeenCalled();
    });
});

// An iOS PWA is frozen while backgrounded: its live channel is dead, so data shown as "verified"
// before may be hours old by the time it comes back. The resume tells the app how long it was away.
describe('subscribeToAppResume — time away', () => {
    it('reports how long the app was hidden', () => {
        const onResume = vi.fn();
        const clock = { now: 1_000 };
        unsubscribe = subscribeToAppResume(onResume, () => clock.now);

        setVisibility('hidden');
        documentStub.dispatchEvent(new Event('visibilitychange'));
        clock.now += 6_000;
        setVisibility('visible');
        documentStub.dispatchEvent(new Event('visibilitychange'));

        expect(onResume).toHaveBeenCalledWith({ awayMs: 6_000 });
    });

    it('counts from pagehide too — iOS may freeze a PWA without a hidden visibilitychange', () => {
        const onResume = vi.fn();
        const clock = { now: 1_000 };
        unsubscribe = subscribeToAppResume(onResume, () => clock.now);

        windowStub.dispatchEvent(new Event('pagehide'));
        clock.now += 9_000;
        windowStub.dispatchEvent(new Event('pageshow'));

        expect(onResume).toHaveBeenCalledWith({ awayMs: 9_000 });
    });

    it('reports no time away for the pageshow of an ordinary page load', () => {
        const onResume = vi.fn();
        unsubscribe = subscribeToAppResume(onResume, () => 1_000);

        windowStub.dispatchEvent(new Event('pageshow'));

        expect(onResume).toHaveBeenCalledWith({ awayMs: null });
    });
});

describe('isAwayLongEnoughToDoubtData', () => {
    it('doubts the data after a long time away', () => {
        expect(isAwayLongEnoughToDoubtData(LONG_AWAY_MS)).toBe(true);
    });

    it('trusts it after a quick switch to another app or tab', () => {
        expect(isAwayLongEnoughToDoubtData(LONG_AWAY_MS - 1)).toBe(false);
    });

    it('trusts it when the app was never hidden', () => {
        expect(isAwayLongEnoughToDoubtData(null)).toBe(false);
    });

    // The e2e harness shrinks the threshold so a spec can background the page for real seconds.
    it('follows a shortened threshold, and the default once restored', () => {
        setLongAwayMs(2_000);
        expect(isAwayLongEnoughToDoubtData(2_000)).toBe(true);

        setLongAwayMs(LONG_AWAY_MS);
        expect(isAwayLongEnoughToDoubtData(2_000)).toBe(false);
    });
});
