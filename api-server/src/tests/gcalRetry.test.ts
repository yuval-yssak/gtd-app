import { afterEach, describe, expect, it, vi } from 'vitest';
import { retryWithBackoff } from '../lib/gcalRetry.js';

afterEach(() => {
    vi.useRealTimers();
});

describe('retryWithBackoff', () => {
    it('returns immediately when the call succeeds on the first attempt', async () => {
        const fn = vi.fn().mockResolvedValue('ok');
        const result = await retryWithBackoff(fn, () => true);
        expect(result).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('rethrows immediately when isTransient returns false', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('terminal'));
        await expect(retryWithBackoff(fn, () => false)).rejects.toThrow('terminal');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries up to 3 times then rethrows the final error', async () => {
        // Pure helper test — fake timers are safe here (no DB / network in the SUT).
        vi.useFakeTimers();
        const fn = vi.fn().mockRejectedValue(new Error('boom'));
        const promise = retryWithBackoff(fn, () => true);
        // Attach the rejection assertion BEFORE draining the timer queue. Without an attached
        // .catch (which `expect(...).rejects` provides), node logs an "unhandled rejection"
        // warning the moment retryWithBackoff exhausts its budget.
        const assertion = expect(promise).rejects.toThrow('boom');
        // Drain all scheduled timers in order: 1s, 5s, 24s. runAllTimersAsync handles the entire
        // chain because each setTimeout resolves to a follow-up call inside the loop.
        await vi.runAllTimersAsync();
        await assertion;
        // 1 initial + 3 retries = 4 attempts total.
        expect(fn).toHaveBeenCalledTimes(4);
    });

    it('succeeds on the second attempt after one transient failure', async () => {
        vi.useFakeTimers();
        const fn = vi.fn().mockRejectedValueOnce(new Error('flake')).mockResolvedValueOnce('ok');
        const promise = retryWithBackoff(fn, () => true);
        await vi.runAllTimersAsync();
        const result = await promise;
        expect(result).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(2);
    });
});
