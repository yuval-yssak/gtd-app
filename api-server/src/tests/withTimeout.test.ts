import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTimeout } from '../lib/claude/tools.js';

/**
 * Unit-tests the real timer + Promise.race behavior of withTimeout (the degrade test in
 * v1ClaudeAssist only simulates a timeout by reproducing the error string, so the real timer, race
 * ordering, and no-leak property are unverified there). Fake timers are safe here — no I/O.
 */
describe('withTimeout', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('resolves with the promise value when it settles before the timeout', async () => {
        const fast = Promise.resolve('value');
        await expect(withTimeout(fast, 1_000, 'fast')).resolves.toBe('value');
    });

    it('rejects with a labelled timeout error when the promise is too slow', async () => {
        const settled = withTimeout(new Promise(() => {}), 8_000, 'getCalendarEvents');
        const assertion = expect(settled).rejects.toThrow('getCalendarEvents timed out after 8000ms');
        await vi.advanceTimersByTimeAsync(8_000);
        await assertion;
    });

    it('clears the timer when the promise wins (no dangling timer)', async () => {
        const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
        await withTimeout(Promise.resolve(1), 5_000, 'x');
        expect(clearSpy).toHaveBeenCalled();
        // No timers left pending — the timeout was cancelled, not left to fire.
        expect(vi.getTimerCount()).toBe(0);
    });
});
