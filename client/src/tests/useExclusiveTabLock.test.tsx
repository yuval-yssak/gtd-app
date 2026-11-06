// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useExclusiveTabLock } from '../hooks/useExclusiveTabLock';
import { installStealableLocks, uninstallLocks } from './fakeWebLocks';

beforeEach(() => {
    installStealableLocks();
});

afterEach(() => {
    cleanup();
    uninstallLocks();
    vi.restoreAllMocks();
});

/** One tab on the shared origin: every hook rendered here talks to the same fake lock manager. */
function renderTab(name: string | null) {
    return renderHook(({ lockName }) => useExclusiveTabLock(lockName), { initialProps: { lockName: name } });
}

describe('useExclusiveTabLock', () => {
    it('the first tab holds the lock; a second tab sees it held elsewhere', async () => {
        const first = renderTab('review');
        await waitFor(() => expect(first.result.current.state).toBe('held'));

        const second = renderTab('review');
        await waitFor(() => expect(second.result.current.state).toBe('heldElsewhere'));
        expect(first.result.current.state).toBe('held');
    });

    it('"Continue here" steals the lock: the taker holds it, the previous holder learns it lost it', async () => {
        const first = renderTab('review');
        await waitFor(() => expect(first.result.current.state).toBe('held'));
        const second = renderTab('review');
        await waitFor(() => expect(second.result.current.state).toBe('heldElsewhere'));

        act(() => second.result.current.takeOver());

        await waitFor(() => expect(second.result.current.state).toBe('held'));
        await waitFor(() => expect(first.result.current.state).toBe('heldElsewhere'));
    });

    // A waiting tab picks the lock up by itself once the holder goes away (closed tab) — and the
    // generation tells the page it (re)gained ownership, so it reloads the saved review.
    it('a tab that saw the lock held elsewhere takes it over automatically when the holder closes', async () => {
        const first = renderTab('review');
        await waitFor(() => expect(first.result.current.state).toBe('held'));
        const second = renderTab('review');
        await waitFor(() => expect(second.result.current.state).toBe('heldElsewhere'));

        first.unmount();

        await waitFor(() => expect(second.result.current.state).toBe('held'));
        expect(second.result.current.generation).toBe(1);
    });

    it('each gain of the lock bumps the generation — a stolen-then-retaken tab knows to reload', async () => {
        const first = renderTab('review');
        await waitFor(() => expect(first.result.current.generation).toBe(1));
        const second = renderTab('review');
        await waitFor(() => expect(second.result.current.state).toBe('heldElsewhere'));

        act(() => second.result.current.takeOver());
        await waitFor(() => expect(first.result.current.state).toBe('heldElsewhere'));
        act(() => first.result.current.takeOver());

        await waitFor(() => expect(first.result.current.state).toBe('held'));
        expect(first.result.current.generation).toBe(2);
        await waitFor(() => expect(second.result.current.state).toBe('heldElsewhere'));
    });

    it('takeOver while already holding the lock is a no-op', async () => {
        const tab = renderTab('review');
        await waitFor(() => expect(tab.result.current.generation).toBe(1));

        act(() => tab.result.current.takeOver());

        expect(tab.result.current).toMatchObject({ state: 'held', generation: 1 });
    });

    it('unmounting the holder releases the lock for the next tab', async () => {
        const first = renderTab('review');
        await waitFor(() => expect(first.result.current.state).toBe('held'));
        first.unmount();

        const second = renderTab('review');
        await waitFor(() => expect(second.result.current.state).toBe('held'));
    });

    it('different names never contend', async () => {
        const personal = renderTab('review:personal');
        const work = renderTab('review:work');
        await waitFor(() => expect(personal.result.current.state).toBe('held'));
        await waitFor(() => expect(work.result.current.state).toBe('held'));
    });

    // StrictMode mounts, tears down and remounts: the torn-down first request must not leave the
    // tab believing another tab owns the lock.
    it('settles on held in a single StrictMode tab', async () => {
        const tab = renderHook(() => useExclusiveTabLock('review'), { reactStrictMode: true });
        await waitFor(() => expect(tab.result.current.state).toBe('held'));
        // ≥ 1, not exactly 1: when the torn-down request was granted first, the remount regains
        // it — one extra reload of the saved state, which is harmless.
        expect(tab.result.current.generation).toBeGreaterThanOrEqual(1);
    });

    it('no name (no account yet) requests nothing and stays pending', async () => {
        const tab = renderTab(null);
        const other = renderTab('review');
        await waitFor(() => expect(other.result.current.state).toBe('held'));
        expect(tab.result.current.state).toBe('pending');
    });

    // An account switch changes the name: the old account's ownership must not carry over, and a
    // takeOver made for the old account must not steal the new account's review from another tab.
    it('a name change never inherits ownership nor steals the new name on behalf of an old takeOver', async () => {
        const otherTab = renderTab('review:work');
        await waitFor(() => expect(otherTab.result.current.state).toBe('held'));
        const holderOfPersonal = renderTab('review:personal');
        await waitFor(() => expect(holderOfPersonal.result.current.state).toBe('held'));
        const tab = renderTab('review:personal');
        await waitFor(() => expect(tab.result.current.state).toBe('heldElsewhere'));
        act(() => tab.result.current.takeOver());
        await waitFor(() => expect(tab.result.current.state).toBe('held'));

        tab.rerender({ lockName: 'review:work' });

        await waitFor(() => expect(tab.result.current.state).toBe('heldElsewhere'));
        expect(otherTab.result.current.state).toBe('held');
    });

    it('switching away and back after a takeover does not steal the lock again', async () => {
        const tab = renderTab('review:personal');
        await waitFor(() => expect(tab.result.current.state).toBe('held'));
        const otherTab = renderTab('review:personal');
        await waitFor(() => expect(otherTab.result.current.state).toBe('heldElsewhere'));
        act(() => otherTab.result.current.takeOver());
        await waitFor(() => expect(otherTab.result.current.state).toBe('held'));

        otherTab.rerender({ lockName: 'review:work' });
        await waitFor(() => expect(otherTab.result.current.state).toBe('held'));
        await waitFor(() => expect(tab.result.current.state).toBe('held')); // personal handed back on leaving
        otherTab.rerender({ lockName: 'review:personal' });

        await waitFor(() => expect(otherTab.result.current.state).toBe('heldElsewhere'));
        expect(tab.result.current.state).toBe('held');
    });

    it('a lock request failing for any reason but a steal runs unlocked instead of retrying forever', async () => {
        const request = vi.fn(() => Promise.reject(new DOMException('opaque origin', 'SecurityError')));
        Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        const tab = renderTab('review');

        await waitFor(() => expect(tab.result.current.state).toBe('held'));
        expect(tab.result.current.generation).toBe(1);
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('without the Web Locks API every tab holds it at once — the pre-lock behaviour', () => {
        uninstallLocks();
        const tab = renderTab('review');
        expect(tab.result.current).toMatchObject({ state: 'held', generation: 1 });
    });
});
