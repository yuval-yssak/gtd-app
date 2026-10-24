import { vi } from 'vitest';

type LockCallback = () => Promise<unknown>;
type LockRequestOptions = { signal?: AbortSignal };

/**
 * A Web Locks stand-in with real queueing semantics: one holder per name, later requests wait in
 * order, and a `signal` that aborts before the grant rejects the request with the signal's reason
 * (the waiter leaves the queue; the holder is untouched) — the behaviour `flushUnderWebLock` relies
 * on. Returns the lock names requested, for wiring assertions.
 */
export function installQueueingLocks(): string[] {
    const names: string[] = [];
    const tails = new Map<string, Promise<void>>();
    const request = vi.fn((name: string, optionsOrCallback: LockRequestOptions | LockCallback, maybeCallback?: LockCallback) => {
        names.push(name);
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
        const signal = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback.signal;
        if (!callback) {
            throw new Error('fake locks: callback required');
        }
        const previous = tails.get(name) ?? Promise.resolve();
        return new Promise<unknown>((resolve, reject) => {
            // Spec: a pre-grant abort rejects with `signal.reason` — the identity `flushUnderWebLock` keys on.
            const onAbort = () => reject(signal?.reason);
            signal?.addEventListener('abort', onAbort, { once: true });
            const tail = previous.then(async () => {
                if (signal?.aborted) return;
                signal?.removeEventListener('abort', onAbort);
                await callback().then(resolve, reject);
            });
            tails.set(name, tail);
        });
    });
    Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
    return names;
}

/** Removes the fake — node has no `navigator.locks`, so code under test falls back to running unserialized. */
export function uninstallLocks(): void {
    Reflect.deleteProperty(navigator, 'locks');
}
