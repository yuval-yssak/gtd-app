import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAutosaveController } from '../lib/autosaveController';

interface Text {
    title: string;
    notes: string;
}

const initial: Text = { title: 'a', notes: '' };

function makeCommitSpy() {
    return vi.fn<(value: Text, baseline: Text) => Promise<void>>().mockResolvedValue(undefined);
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('createAutosaveController', () => {
    it('commits once, delayMs after the last change of a burst', async () => {
        const commit = makeCommitSpy();
        const controller = createAutosaveController({ initial, commit, delayMs: 800 });

        controller.onChange({ title: 'ab', notes: '' });
        await vi.advanceTimersByTimeAsync(500);
        controller.onChange({ title: 'abc', notes: '' });
        await vi.advanceTimersByTimeAsync(799);
        expect(commit).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(commit).toHaveBeenCalledTimes(1);
        expect(commit).toHaveBeenCalledWith({ title: 'abc', notes: '' }, initial);
    });

    it('does not commit when the value returns to the last-committed state', async () => {
        const commit = makeCommitSpy();
        const controller = createAutosaveController({ initial, commit, delayMs: 800 });

        controller.onChange({ title: 'ab', notes: '' });
        controller.onChange({ ...initial });
        await vi.advanceTimersByTimeAsync(2000);
        expect(commit).not.toHaveBeenCalled();
        expect(controller.isDirty()).toBe(false);
    });

    it('keeps the pre-burst baseline across successive commits until endBurst', async () => {
        const commit = makeCommitSpy();
        const controller = createAutosaveController({ initial, commit, delayMs: 100 });

        controller.onChange({ title: 'ab', notes: '' });
        await vi.advanceTimersByTimeAsync(100);
        controller.onChange({ title: 'abc', notes: '' });
        await vi.advanceTimersByTimeAsync(100);

        expect(commit).toHaveBeenNthCalledWith(1, { title: 'ab', notes: '' }, initial);
        expect(commit).toHaveBeenNthCalledWith(2, { title: 'abc', notes: '' }, initial);

        controller.endBurst();
        controller.onChange({ title: 'abcd', notes: '' });
        await vi.advanceTimersByTimeAsync(100);
        expect(commit).toHaveBeenNthCalledWith(3, { title: 'abcd', notes: '' }, { title: 'abc', notes: '' });
    });

    it('flush commits immediately and is a no-op when clean', async () => {
        const commit = makeCommitSpy();
        const controller = createAutosaveController({ initial, commit, delayMs: 800 });

        await controller.flush();
        expect(commit).not.toHaveBeenCalled();

        controller.onChange({ title: 'ab', notes: '' });
        await controller.flush();
        expect(commit).toHaveBeenCalledTimes(1);
        // The debounce timer must be cancelled — no second commit later.
        await vi.advanceTimersByTimeAsync(2000);
        expect(commit).toHaveBeenCalledTimes(1);
    });

    it('reset adopts an external value without committing and drops pending work', async () => {
        const commit = makeCommitSpy();
        const controller = createAutosaveController({ initial, commit, delayMs: 800 });

        controller.onChange({ title: 'ab', notes: '' });
        controller.reset({ title: 'remote', notes: 'r' });
        await vi.advanceTimersByTimeAsync(2000);
        expect(commit).not.toHaveBeenCalled();
        expect(controller.isDirty()).toBe(false);

        // Edits after the reset baseline against the external value.
        controller.onChange({ title: 'remote!', notes: 'r' });
        await vi.advanceTimersByTimeAsync(800);
        expect(commit).toHaveBeenCalledWith({ title: 'remote!', notes: 'r' }, { title: 'remote', notes: 'r' });
    });

    it('a change arriving during an in-flight commit is committed exactly once by a waiting flush', async () => {
        const resolvers: Array<() => void> = [];
        const commit = vi.fn<(value: Text, baseline: Text) => Promise<void>>().mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    resolvers.push(resolve);
                }),
        );
        const controller = createAutosaveController({ initial, commit, delayMs: 100 });

        controller.onChange({ title: 'ab', notes: '' });
        await vi.advanceTimersByTimeAsync(100);
        expect(commit).toHaveBeenCalledTimes(1);

        // New keystroke while the first commit hangs, then a flush: it must wait out the first
        // commit and then commit the newer value exactly once.
        controller.onChange({ title: 'abc', notes: '' });
        const flushPromise = controller.flush();
        resolvers[0]?.();
        await vi.advanceTimersByTimeAsync(0);
        resolvers[1]?.();
        await flushPromise;

        expect(commit).toHaveBeenCalledTimes(2);
        expect(commit).toHaveBeenNthCalledWith(2, { title: 'abc', notes: '' }, initial);
        expect(controller.isDirty()).toBe(false);
    });

    it('serializes overlapping commits — a flush during an in-flight commit waits, then re-checks dirtiness', async () => {
        let resolveFirst: (() => void) | undefined;
        const commit = vi.fn<(value: Text, baseline: Text) => Promise<void>>().mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    resolveFirst = resolve;
                }),
        );
        const controller = createAutosaveController({ initial, commit, delayMs: 100 });

        controller.onChange({ title: 'ab', notes: '' });
        await vi.advanceTimersByTimeAsync(100);
        expect(commit).toHaveBeenCalledTimes(1);

        // Flush while the first commit hangs; no new value typed, so after the first commit
        // lands the flush must find the controller clean and not double-commit.
        const flushPromise = controller.flush();
        resolveFirst?.();
        await flushPromise;
        expect(commit).toHaveBeenCalledTimes(1);
    });
});
