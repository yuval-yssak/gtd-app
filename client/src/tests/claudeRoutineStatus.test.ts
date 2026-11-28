import { describe, expect, it, vi } from 'vitest';
import { CLAUDE_ROUTINE_STATUS_TTL_MS, createClaudeRoutineStatusStore } from '../lib/claudeRoutineStatus';

/** A store on a hand-moved clock; each check gets its own deadline, which fires only when the test says so. */
function storeAt(startMs: number) {
    const clock = { nowMs: startMs };
    const deadlines: ReturnType<typeof deferred<never>>[] = [];
    const store = createClaudeRoutineStatusStore({
        nowMs: () => clock.nowMs,
        deadline: () => {
            const deadline = deferred<never>();
            deadlines.push(deadline);
            return deadline.promise;
        },
    });
    return { clock, store, expireLatestDeadline: () => deadlines.at(-1)?.reject(new Error('deadline')) };
}

function deferred<T>() {
    const handles: { resolve: (value: T) => void; reject: (err: Error) => void } = { resolve: () => {}, reject: () => {} };
    const promise = new Promise<T>((resolve, reject) => {
        handles.resolve = resolve;
        handles.reject = reject;
    });
    return { promise, ...handles };
}

describe('claudeRoutineStatusStore', () => {
    it('is unknown until an account is checked, then reports what the check found', async () => {
        const { store } = storeAt(0);
        expect(store.statusOf('u1')).toBe('unknown');
        await store.refresh('u1', async () => false);
        expect(store.statusOf('u1')).toBe('notConnected');
        expect(store.statusOf('u2')).toBe('unknown');
    });

    it('keeps each account separate', async () => {
        const { store } = storeAt(0);
        await store.refresh('u1', async () => true);
        await store.refresh('u2', async () => false);
        expect(store.statusOf('u1')).toBe('connected');
        expect(store.statusOf('u2')).toBe('notConnected');
    });

    it('skips a check while the last one is fresh, and re-checks once it is stale', async () => {
        const { clock, store } = storeAt(0);
        const check = vi.fn(async () => true);
        await store.refresh('u1', check);
        clock.nowMs = CLAUDE_ROUTINE_STATUS_TTL_MS - 1;
        await store.refresh('u1', check);
        expect(check).toHaveBeenCalledTimes(1);
        clock.nowMs = CLAUDE_ROUTINE_STATUS_TTL_MS;
        await store.refresh('u1', check);
        expect(check).toHaveBeenCalledTimes(2);
    });

    it('re-checks a fresh entry when forced', async () => {
        const { store } = storeAt(0);
        await store.refresh('u1', async () => true);
        await store.refresh('u1', async () => false, { isForced: true });
        expect(store.statusOf('u1')).toBe('notConnected');
    });

    it('shares one in-flight check between concurrent callers, forced ones included', async () => {
        const { store } = storeAt(0);
        const check = vi.fn(async () => true);
        await Promise.all([store.refresh('u1', check), store.refresh('u1', check), store.refresh('u1', check, { isForced: true })]);
        expect(check).toHaveBeenCalledTimes(1);
    });

    it('keeps the last known status when a check fails', async () => {
        const { store } = storeAt(0);
        await store.refresh('u1', async () => true);
        await store.refresh('u1', () => Promise.reject(new Error('offline')), { isForced: true });
        expect(store.statusOf('u1')).toBe('connected');
    });

    it('does not count a failed first check as an answer: the next refresh checks again', async () => {
        const { store } = storeAt(0);
        await store.refresh('u1', () => Promise.reject(new Error('offline')));
        expect(store.statusOf('u1')).toBe('unknown');
        const check = vi.fn(async () => false);
        await store.refresh('u1', check);
        expect(check).toHaveBeenCalledTimes(1);
        expect(store.statusOf('u1')).toBe('notConnected');
    });

    it('lets an answer written during a check win over that older check', async () => {
        const { store } = storeAt(0);
        const slowRead = deferred<boolean>();
        const check = store.refresh('u1', () => slowRead.promise);
        store.remember('u1', true); // Settings saved while the read was in flight
        slowRead.resolve(false);
        await check;
        expect(store.statusOf('u1')).toBe('connected');
    });

    it('gives up on a check that never settles, so the next refresh can run its own', async () => {
        const { store, expireLatestDeadline } = storeAt(0);
        const hung = store.refresh('u1', () => new Promise<boolean>(() => {}));
        expireLatestDeadline();
        await hung;
        expect(store.statusOf('u1')).toBe('unknown');
        await store.refresh('u1', async () => true);
        expect(store.statusOf('u1')).toBe('connected');
    });

    it('takes a status Settings already knows without a check, and notifies subscribers', () => {
        const { store } = storeAt(0);
        const listener = vi.fn();
        const unsubscribe = store.subscribe(listener);
        store.remember('u1', true);
        expect(store.statusOf('u1')).toBe('connected');
        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe();
        store.remember('u1', false);
        expect(listener).toHaveBeenCalledTimes(1);
    });
});
