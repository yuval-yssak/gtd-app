import { describe, expect, it } from 'vitest';
import { KeyedMutex } from '../lib/keyedMutex.js';

/** Resolvable gate — lets a test hold a task open until the assertion point. */
function gate() {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
        open = resolve;
    });
    return { open, opened };
}

describe('KeyedMutex', () => {
    it('serializes tasks sharing a key in FIFO order', async () => {
        const mutex = new KeyedMutex();
        const order: string[] = [];
        const firstGate = gate();

        const first = mutex.withLock('k', async () => {
            order.push('first-start');
            await firstGate.opened;
            order.push('first-end');
        });
        const second = mutex.withLock('k', async () => {
            order.push('second-start');
        });

        // Give the second task a chance to (incorrectly) start while the first holds the lock.
        await new Promise((resolve) => setImmediate(resolve));
        expect(order).toEqual(['first-start']);

        firstGate.open();
        await Promise.all([first, second]);
        expect(order).toEqual(['first-start', 'first-end', 'second-start']);
    });

    it('runs tasks with different keys concurrently', async () => {
        const mutex = new KeyedMutex();
        const order: string[] = [];
        const aGate = gate();

        const a = mutex.withLock('a', async () => {
            order.push('a-start');
            await aGate.opened;
        });
        const b = mutex.withLock('b', async () => {
            order.push('b-start');
        });

        await b;
        // b completed while a is still holding its (different) key.
        expect(order).toEqual(['a-start', 'b-start']);
        aGate.open();
        await a;
    });

    it('propagates a rejection to its own awaiter without poisoning queued tasks', async () => {
        const mutex = new KeyedMutex();
        const failing = mutex.withLock('k', async () => {
            throw new Error('boom');
        });
        const queued = mutex.withLock('k', async () => 'ran-anyway');

        await expect(failing).rejects.toThrow('boom');
        await expect(queued).resolves.toBe('ran-anyway');
    });

    it('returns the task result', async () => {
        const mutex = new KeyedMutex();
        await expect(mutex.withLock('k', async () => 42)).resolves.toBe(42);
    });

    it('releases the key after the chain settles so later tasks start fresh', async () => {
        const mutex = new KeyedMutex();
        await mutex.withLock('k', async () => 'one');
        // A fresh acquisition after full settle must not deadlock or inherit stale chain state.
        await expect(mutex.withLock('k', async () => 'two')).resolves.toBe('two');
    });
});
