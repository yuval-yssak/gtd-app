import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ACCOUNT_NEEDS_REAUTH_EVENT,
    dismissAccountReauth,
    dispatchAccountNeedsReauth,
    flagAccountNeedsReauth,
    getReauthFlaggedUserIds,
    resetAccountReauthStore,
    subscribeAccountReauth,
} from '../contexts/accountReauthEvents';

// The banner is a thin view over this shared store (state lives here, not in the component, because
// AppNav double-mounts the banner). These cover the de-dupe + dismiss-stickiness the reviewer flagged.

beforeEach(() => {
    resetAccountReauthStore();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('account reauth store', () => {
    it('exposes a flagged userId and de-dupes repeated flags', () => {
        flagAccountNeedsReauth('user-a');
        flagAccountNeedsReauth('user-a');
        flagAccountNeedsReauth('user-b');

        expect(getReauthFlaggedUserIds()).toEqual(['user-a', 'user-b']);
    });

    it('keeps a dismissed userId hidden even when re-flagged (orchestrator re-dispatches each cycle)', () => {
        flagAccountNeedsReauth('user-a');
        dismissAccountReauth('user-a');
        // Simulate the orchestrator re-dispatching on the next sync cycle.
        flagAccountNeedsReauth('user-a');

        expect(getReauthFlaggedUserIds()).toEqual([]);
    });

    it('only hides the dismissed account, not its siblings', () => {
        flagAccountNeedsReauth('user-a');
        flagAccountNeedsReauth('user-b');
        dismissAccountReauth('user-a');

        expect(getReauthFlaggedUserIds()).toEqual(['user-b']);
    });

    it('returns a referentially stable snapshot when membership is unchanged', () => {
        flagAccountNeedsReauth('user-a');
        const first = getReauthFlaggedUserIds();
        flagAccountNeedsReauth('user-a'); // no-op — already flagged
        expect(getReauthFlaggedUserIds()).toBe(first); // same reference → no useSyncExternalStore churn
    });

    it('notifies subscribers on change and stops after unsubscribe', () => {
        const onChange = vi.fn();
        const unsubscribe = subscribeAccountReauth(onChange);

        flagAccountNeedsReauth('user-a');
        expect(onChange).toHaveBeenCalledTimes(1);

        unsubscribe();
        flagAccountNeedsReauth('user-b');
        expect(onChange).toHaveBeenCalledTimes(1); // no further notifications after unsubscribe
    });

    it('dispatchAccountNeedsReauth fires a CustomEvent carrying the userId', () => {
        const dispatchSpy = vi.fn();
        vi.stubGlobal('window', { dispatchEvent: dispatchSpy } as unknown as Window);

        dispatchAccountNeedsReauth('user-x');

        const [event] = dispatchSpy.mock.calls.map(([e]) => e as CustomEvent);
        if (!event) throw new Error('expected a dispatched event');
        expect(event.type).toBe(ACCOUNT_NEEDS_REAUTH_EVENT);
        expect(event.detail).toEqual({ userId: 'user-x' });
    });

    it('dispatchAccountNeedsReauth is a no-op when there is no window (SW / Node env)', () => {
        // window is undefined under the `node` test env by default — must not throw.
        expect(() => dispatchAccountNeedsReauth('user-y')).not.toThrow();
    });
});
