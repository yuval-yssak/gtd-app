import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ACCOUNT_NEEDS_REAUTH_EVENT,
    acknowledgeAccountReauthDialog,
    announceAccountReauthResolved,
    clearAccountReauth,
    clearAccountReauthAfterSuccessfulSync,
    dismissAccountReauth,
    dispatchAccountNeedsReauth,
    ensureAccountReauthBridge,
    flagAccountNeedsReauth,
    getReauthDialogUserIds,
    getReauthFlaggedUserIds,
    isAccountFlaggedForReauth,
    REAUTH_RESOLVED_STORAGE_KEY,
    resetAccountReauthBridgeForTests,
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

// A re-login (or a sync pass succeeding again) must clear the stale "Sync is broken" dialog in
// every open tab — the flag lives in a per-tab module store, so without an explicit clear path
// the other tabs keep the dialog until a manual reload.
describe('account reauth resolution', () => {
    it('clearAccountReauth removes the flag from both tiers and notifies subscribers', () => {
        flagAccountNeedsReauth('user-a');
        const onChange = vi.fn();
        subscribeAccountReauth(onChange);

        clearAccountReauth('user-a');

        expect(getReauthFlaggedUserIds()).toEqual([]);
        expect(getReauthDialogUserIds()).toEqual([]);
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('clearAccountReauth only clears the targeted account, not its siblings', () => {
        flagAccountNeedsReauth('user-a');
        flagAccountNeedsReauth('user-b');

        clearAccountReauth('user-a');

        expect(getReauthFlaggedUserIds()).toEqual(['user-b']);
        expect(getReauthDialogUserIds()).toEqual(['user-b']);
    });

    it('clearAccountReauth drops dismissals too, so a future breakage re-alerts with the dialog', () => {
        flagAccountNeedsReauth('user-a');
        dismissAccountReauth('user-a');
        clearAccountReauth('user-a');

        // A NEW incident after the account was healed — must show both tiers again.
        flagAccountNeedsReauth('user-a');

        expect(getReauthDialogUserIds()).toEqual(['user-a']);
        expect(getReauthFlaggedUserIds()).toEqual(['user-a']);
    });

    it('clearAccountReauth drops the dialog acknowledgement, so a future breakage re-opens the dialog', () => {
        flagAccountNeedsReauth('user-a');
        acknowledgeAccountReauthDialog('user-a'); // "Not now" — banner stays, dialog closes
        clearAccountReauth('user-a');

        flagAccountNeedsReauth('user-a'); // a NEW incident
        expect(getReauthDialogUserIds()).toEqual(['user-a']);
    });

    it('clearAccountReauth for a user with no reauth state does not notify subscribers', () => {
        const onChange = vi.fn();
        subscribeAccountReauth(onChange);
        clearAccountReauth('never-flagged');
        expect(onChange).not.toHaveBeenCalled();
    });

    it('announceAccountReauthResolved clears locally and writes the cross-tab storage payload', () => {
        const setItem = vi.fn();
        vi.stubGlobal('localStorage', { setItem } as unknown as Storage);
        flagAccountNeedsReauth('user-a');

        announceAccountReauthResolved('user-a');

        expect(getReauthFlaggedUserIds()).toEqual([]);
        expect(setItem).toHaveBeenCalledTimes(1);
        const [key, rawValue] = setItem.mock.calls[0] as [string, string];
        expect(key).toBe(REAUTH_RESOLVED_STORAGE_KEY);
        expect(JSON.parse(rawValue)).toMatchObject({ userId: 'user-a' });
    });

    it('announceAccountReauthResolved does not throw without localStorage (SW / Node env)', () => {
        expect(() => announceAccountReauthResolved('user-a')).not.toThrow();
    });

    it('announceAccountReauthResolved still clears locally when the storage write throws (Safari private mode)', () => {
        vi.stubGlobal('localStorage', {
            setItem: () => {
                throw new Error('QuotaExceededError');
            },
        } as unknown as Storage);
        flagAccountNeedsReauth('user-a');

        expect(() => announceAccountReauthResolved('user-a')).not.toThrow();
        expect(getReauthFlaggedUserIds()).toEqual([]);
    });

    it('isAccountFlaggedForReauth reflects flag state and ignores dismissals', () => {
        expect(isAccountFlaggedForReauth('user-a')).toBe(false);
        flagAccountNeedsReauth('user-a');
        dismissAccountReauth('user-a'); // hidden from the UI, but the flag itself is still active
        expect(isAccountFlaggedForReauth('user-a')).toBe(true);
        clearAccountReauth('user-a');
        expect(isAccountFlaggedForReauth('user-a')).toBe(false);
    });

    it('clearAccountReauthAfterSuccessfulSync is a no-op for an unflagged user (no storage churn)', () => {
        const setItem = vi.fn();
        vi.stubGlobal('localStorage', { setItem } as unknown as Storage);

        clearAccountReauthAfterSuccessfulSync('healthy-user');

        expect(setItem).not.toHaveBeenCalled();
    });

    it('clearAccountReauthAfterSuccessfulSync clears and broadcasts for a flagged user', () => {
        const setItem = vi.fn();
        vi.stubGlobal('localStorage', { setItem } as unknown as Storage);
        flagAccountNeedsReauth('user-a');

        clearAccountReauthAfterSuccessfulSync('user-a');

        expect(getReauthFlaggedUserIds()).toEqual([]);
        expect(setItem).toHaveBeenCalledTimes(1);
    });
});

describe('cross-tab resolved bridge', () => {
    /** Installs the bridge against a stubbed window and returns the captured event listeners. */
    function installBridgeOnStubbedWindow() {
        const listenersByType = new Map<string, (event: unknown) => void>();
        vi.stubGlobal('window', {
            addEventListener: (type: string, listener: (event: unknown) => void) => listenersByType.set(type, listener),
        } as unknown as Window);
        resetAccountReauthBridgeForTests();
        ensureAccountReauthBridge();
        return listenersByType;
    }

    it('a resolved storage event from another tab clears the flag on both tiers', () => {
        const listenersByType = installBridgeOnStubbedWindow();
        flagAccountNeedsReauth('user-a');

        listenersByType.get('storage')?.({ key: REAUTH_RESOLVED_STORAGE_KEY, newValue: JSON.stringify({ userId: 'user-a', ts: 1 }) });

        expect(getReauthFlaggedUserIds()).toEqual([]);
        expect(getReauthDialogUserIds()).toEqual([]);
    });

    it('ignores storage events for other keys and malformed payloads', () => {
        const listenersByType = installBridgeOnStubbedWindow();
        flagAccountNeedsReauth('user-a');
        const onStorage = listenersByType.get('storage');

        onStorage?.({ key: 'some-other-key', newValue: JSON.stringify({ userId: 'user-a' }) });
        onStorage?.({ key: REAUTH_RESOLVED_STORAGE_KEY, newValue: 'not-json{' });
        onStorage?.({ key: REAUTH_RESOLVED_STORAGE_KEY, newValue: JSON.stringify({ userId: 42 }) });
        onStorage?.({ key: REAUTH_RESOLVED_STORAGE_KEY, newValue: null });

        expect(getReauthFlaggedUserIds()).toEqual(['user-a']);
    });
});
