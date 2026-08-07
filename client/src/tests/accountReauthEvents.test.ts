import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ACCOUNT_NEEDS_REAUTH_EVENT,
    acknowledgeAccountReauthDialog,
    dismissAccountReauth,
    dispatchAccountNeedsReauth,
    flagAccountNeedsReauth,
    getReauthDialogUserIds,
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

    it('a fresh flag shows on both the dialog and banner tiers', () => {
        flagAccountNeedsReauth('user-a');

        expect(getReauthDialogUserIds()).toEqual(['user-a']);
        expect(getReauthFlaggedUserIds()).toEqual(['user-a']);
    });

    it('acknowledging the dialog hides it but keeps the banner showing', () => {
        flagAccountNeedsReauth('user-a');
        acknowledgeAccountReauthDialog('user-a');

        expect(getReauthDialogUserIds()).toEqual([]);
        expect(getReauthFlaggedUserIds()).toEqual(['user-a']);
    });

    it('keeps an acknowledged dialog closed when the orchestrator re-flags on the next sync cycle', () => {
        flagAccountNeedsReauth('user-a');
        acknowledgeAccountReauthDialog('user-a');
        flagAccountNeedsReauth('user-a');

        expect(getReauthDialogUserIds()).toEqual([]);
    });

    it('dismissing the banner also acknowledges the dialog (stronger action silences both)', () => {
        flagAccountNeedsReauth('user-a');
        dismissAccountReauth('user-a');
        flagAccountNeedsReauth('user-a');

        expect(getReauthDialogUserIds()).toEqual([]);
        expect(getReauthFlaggedUserIds()).toEqual([]);
    });

    it('only acknowledges the targeted account on the dialog tier, not its siblings', () => {
        flagAccountNeedsReauth('user-a');
        flagAccountNeedsReauth('user-b');
        acknowledgeAccountReauthDialog('user-a');

        expect(getReauthDialogUserIds()).toEqual(['user-b']);
        expect(getReauthFlaggedUserIds()).toEqual(['user-a', 'user-b']);
    });

    it('returns a referentially stable dialog snapshot when membership is unchanged', () => {
        flagAccountNeedsReauth('user-a');
        const first = getReauthDialogUserIds();
        flagAccountNeedsReauth('user-a'); // no-op — already flagged
        expect(getReauthDialogUserIds()).toBe(first);
    });

    it('does not notify subscribers on a repeated dialog acknowledge', () => {
        flagAccountNeedsReauth('user-a');
        acknowledgeAccountReauthDialog('user-a');
        const onChange = vi.fn();
        subscribeAccountReauth(onChange);
        acknowledgeAccountReauthDialog('user-a');
        expect(onChange).not.toHaveBeenCalled();
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
