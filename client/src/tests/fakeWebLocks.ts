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

type ExclusiveLockOptions = { ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal };
type ExclusiveLockCallback = (lock: { name: string } | null) => Promise<unknown> | unknown;
interface ExclusiveLockRequest {
    callback: ExclusiveLockCallback;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    detachAbort?: () => void;
}

/**
 * A Web Locks stand-in for exclusive-ownership locks, with the spec behaviours a "one tab owns
 * this" lock relies on: a plain request QUEUES behind the holder (a pre-grant `signal` abort
 * rejects it with the signal's reason), `ifAvailable` grants `null` when the name is held, and
 * `steal` grants at once while the previous holder's request rejects with an `AbortError` (its
 * callback keeps running, as in the spec). Release grants the next waiter.
 */
export function installStealableLocks(): void {
    const holders = new Map<string, ExclusiveLockRequest>();
    const queues = new Map<string, ExclusiveLockRequest[]>();

    const grant = (name: string, entry: ExclusiveLockRequest) => {
        // Spec: an abort after the grant is ignored — the request is no longer waiting.
        entry.detachAbort?.();
        holders.set(name, entry);
        void Promise.resolve(entry.callback({ name })).then(
            (value) => {
                release(name, entry);
                entry.resolve(value);
            },
            (err: unknown) => {
                release(name, entry);
                entry.reject(err);
            },
        );
    };
    const release = (name: string, entry: ExclusiveLockRequest) => {
        if (holders.get(name) !== entry) {
            return; // stolen meanwhile — the thief owns the name now
        }
        holders.delete(name);
        const next = queues.get(name)?.shift();
        if (next) {
            grant(name, next);
        }
    };
    const request = (name: string, options: ExclusiveLockOptions, callback: ExclusiveLockCallback) =>
        new Promise<unknown>((resolve, reject) => {
            if (options.signal?.aborted) {
                reject(options.signal.reason);
                return;
            }
            const entry: ExclusiveLockRequest = { callback, resolve, reject };
            const current = holders.get(name);
            if (current && options.ifAvailable) {
                void Promise.resolve(callback(null)).then(resolve, reject);
                return;
            }
            if (current && options.steal) {
                holders.delete(name);
                current.reject(new DOMException('The lock was stolen', 'AbortError'));
            }
            if (!holders.has(name)) {
                grant(name, entry);
                return;
            }
            const queue = queues.get(name) ?? [];
            queues.set(name, [...queue, entry]);
            const signal = options.signal;
            if (signal) {
                const onAbort = () => {
                    queues.set(
                        name,
                        (queues.get(name) ?? []).filter((waiting) => waiting !== entry),
                    );
                    reject(signal.reason);
                };
                signal.addEventListener('abort', onAbort, { once: true });
                entry.detachAbort = () => signal.removeEventListener('abort', onAbort);
            }
        });
    Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
}
