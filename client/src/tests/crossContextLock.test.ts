import { afterEach, describe, expect, it, vi } from 'vitest';
import { withCrossContextLock } from '../db/crossContextLock';

/**
 * Minimal queueing LockManager double: grants each request for a name only after the previous
 * holder's callback settles — the same exclusive, queued semantics the real Web Locks API
 * provides. Kept deliberately tiny; the point is observing serialization, not reimplementing
 * the spec (no modes, no ifAvailable, no steal).
 */
function fakeLockManager() {
    const tails = new Map<string, Promise<unknown>>();
    const request = vi.fn((name: string, cb: () => Promise<unknown>) => {
        const previous = tails.get(name) ?? Promise.resolve();
        const run = previous.then(() => cb());
        tails.set(
            name,
            run.catch(() => undefined),
        );
        return run;
    });
    return { request };
}

function installFakeLocks() {
    const fake = fakeLockManager();
    Object.defineProperty(navigator, 'locks', { value: fake, configurable: true });
    return fake;
}

afterEach(() => {
    Reflect.deleteProperty(navigator, 'locks');
});

describe('withCrossContextLock', () => {
    it('runs the task directly when the Web Locks API is unavailable (node / old browsers)', async () => {
        expect('locks' in navigator).toBe(false);
        const result = await withCrossContextLock('gtd-test-lock', async () => 'ran-unlocked');
        expect(result).toBe('ran-unlocked');
    });

    it('delegates to navigator.locks.request with the given name and returns the task result', async () => {
        const fake = installFakeLocks();
        const result = await withCrossContextLock('gtd-test-lock', async () => 42);
        expect(result).toBe(42);
        expect(fake.request).toHaveBeenCalledWith('gtd-test-lock', expect.any(Function));
    });

    it('serializes two tasks contending for the same name — the second never overlaps the first', async () => {
        installFakeLocks();
        const order: string[] = [];
        let releaseFirst!: () => void;
        const firstBlocked = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });

        const first = withCrossContextLock('gtd-test-lock', async () => {
            order.push('first-start');
            await firstBlocked;
            order.push('first-end');
        });
        const second = withCrossContextLock('gtd-test-lock', async () => {
            order.push('second-start');
        });

        // Give the second task every chance to start early — it must stay queued.
        await new Promise((r) => setTimeout(r, 10));
        expect(order).toEqual(['first-start']);

        releaseFirst();
        await Promise.all([first, second]);
        expect(order).toEqual(['first-start', 'first-end', 'second-start']);
    });

    it('releases the lock when the task rejects, letting the next holder in', async () => {
        installFakeLocks();
        await expect(withCrossContextLock('gtd-test-lock', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
        const result = await withCrossContextLock('gtd-test-lock', async () => 'after-failure');
        expect(result).toBe('after-failure');
    });
});
