import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    areAccountsCaughtUp,
    type ConnectionRepairSteps,
    createConnectionSupervisor,
    nextSyncAction,
    REPAIR_STEP_DEADLINE_MS,
} from '../lib/connectionSupervisor';
import { deferred } from './deferred';

/** Steps that all succeed, as spies; a test overrides the ones it is about. */
function fakeSteps(overrides: Partial<ConnectionRepairSteps> = {}) {
    const defaults = {
        ensureLiveChannels: vi.fn(async () => undefined),
        areLiveChannelsUp: vi.fn(() => true),
        seedAccounts: vi.fn(async () => true),
        reconcileSessionCookie: vi.fn(async () => true),
        registerPush: vi.fn(async () => true),
        syncIfBehind: vi.fn(),
        isCaughtUp: vi.fn(() => true),
    };
    return Object.assign(defaults, overrides);
}

/** A step that never settles, like a request on a network that never answers. */
function hangs<T>() {
    return vi.fn(() => new Promise<T>(() => undefined));
}

describe('createConnectionSupervisor', () => {
    it('opens the live channels before it waits on the account list', async () => {
        const steps = fakeSteps({ seedAccounts: hangs<boolean>() });

        void createConnectionSupervisor(steps).repair();
        await Promise.resolve();

        expect(steps.ensureLiveChannels).toHaveBeenCalled();
    });

    it('runs every later step even when an earlier one failed', async () => {
        const steps = fakeSteps({ seedAccounts: vi.fn(async () => false), reconcileSessionCookie: vi.fn(async () => false) });

        await createConnectionSupervisor(steps).repair();

        expect(steps.syncIfBehind).toHaveBeenCalled();
        expect(steps.registerPush).toHaveBeenCalled();
    });

    it('treats a step that throws as failed, and carries on', async () => {
        const steps = fakeSteps({ reconcileSessionCookie: vi.fn(async () => Promise.reject(new Error('Failed to fetch'))) });
        const supervisor = createConnectionSupervisor(steps);

        await supervisor.repair();

        expect(steps.syncIfBehind).toHaveBeenCalled();
        expect(supervisor.isRepaired()).toBe(false);
    });

    it('retries a failed step on the next repair, and never repeats one that succeeded', async () => {
        const steps = fakeSteps({ reconcileSessionCookie: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true) });
        const supervisor = createConnectionSupervisor(steps);

        await supervisor.repair();
        await supervisor.repair();
        await supervisor.repair();

        expect(steps.reconcileSessionCookie).toHaveBeenCalledTimes(2);
        expect(steps.seedAccounts).toHaveBeenCalledTimes(1);
        expect(steps.registerPush).toHaveBeenCalledTimes(1);
    });

    it('checks the live channels on every repair — a channel the browser gave up on is reopened', async () => {
        const steps = fakeSteps();
        const supervisor = createConnectionSupervisor(steps);

        await supervisor.repair();
        await supervisor.repair();

        expect(steps.ensureLiveChannels.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('opens channels again once the account list arrives, for accounts signed in elsewhere', async () => {
        const steps = fakeSteps();

        await createConnectionSupervisor(steps).repair();

        const [firstChannelCheck = 0, secondChannelCheck = 0] = steps.ensureLiveChannels.mock.invocationCallOrder;
        const [accountListCall = 0] = steps.seedAccounts.mock.invocationCallOrder;
        expect(firstChannelCheck).toBeLessThan(accountListCall);
        expect(secondChannelCheck).toBeGreaterThan(accountListCall);
    });

    it('is repaired once the account list and cookie are done, every channel is up and every account is caught up', async () => {
        const health = { channelsUp: false, caughtUp: false };
        const steps = fakeSteps({ areLiveChannelsUp: () => health.channelsUp, isCaughtUp: () => health.caughtUp });
        const supervisor = createConnectionSupervisor(steps);
        expect(supervisor.isRepaired()).toBe(false);

        await supervisor.repair();
        expect(supervisor.isRepaired()).toBe(false);

        health.channelsUp = true;
        expect(supervisor.isRepaired()).toBe(false);

        health.caughtUp = true;
        expect(supervisor.isRepaired()).toBe(true);
    });

    // Push is best-effort: a browser that refuses it for good (push disabled) must not keep the
    // supervisor retrying for the tab's whole life. It is still retried on passes that run anyway.
    it('does not wait on push registration to count as repaired, but retries it on later passes', async () => {
        const steps = fakeSteps({ registerPush: vi.fn(async () => false) });
        const supervisor = createConnectionSupervisor(steps);

        await supervisor.repair();
        expect(supervisor.isRepaired()).toBe(true);

        await supervisor.repair();
        expect(steps.registerPush).toHaveBeenCalledTimes(2);
    });

    it('carries on with the pass when opening the channels throws', async () => {
        const steps = fakeSteps({ ensureLiveChannels: vi.fn(async () => Promise.reject(new Error('IDB unavailable'))) });

        await createConnectionSupervisor(steps).repair();

        expect(steps.seedAccounts).toHaveBeenCalled();
        expect(steps.syncIfBehind).toHaveBeenCalled();
    });

    // After an offline spell the cookie may lag an offline account switch, and a push subscription
    // may have lapsed; the account list does not change by being offline.
    it('re-runs the cookie check and push registration after the network was lost, but not the account list', async () => {
        const steps = fakeSteps();
        const supervisor = createConnectionSupervisor(steps);
        await supervisor.repair();

        supervisor.forgetSessionSteps();
        expect(supervisor.isRepaired()).toBe(false);
        await supervisor.repair();

        expect(steps.reconcileSessionCookie).toHaveBeenCalledTimes(2);
        expect(steps.registerPush).toHaveBeenCalledTimes(2);
        expect(steps.seedAccounts).toHaveBeenCalledTimes(1);
    });

    it('shares one pass between overlapping repairs', async () => {
        const steps = fakeSteps();
        const supervisor = createConnectionSupervisor(steps);

        await Promise.all([supervisor.repair(), supervisor.repair(), supervisor.repair()]);

        expect(steps.seedAccounts).toHaveBeenCalledTimes(1);
        expect(steps.syncIfBehind).toHaveBeenCalledTimes(1);
    });
});

describe('areAccountsCaughtUp', () => {
    const verified = new Set(['user-A']);
    const awaitingSignIn = new Set(['user-B']);
    const accountState = { isVerified: (id: string) => verified.has(id), needsReauth: (id: string) => awaitingSignIn.has(id) };

    it('is true once every account has been checked with the server', () => {
        expect(areAccountsCaughtUp(['user-A'], accountState)).toBe(true);
    });

    it('is false while some account has not been checked', () => {
        expect(areAccountsCaughtUp(['user-A', 'user-C'], accountState)).toBe(false);
    });

    // Its pull fails until the user signs in again; retrying it would loop forever, in every tab.
    it('ignores an account waiting for the user to sign in again', () => {
        expect(areAccountsCaughtUp(['user-A', 'user-B'], accountState)).toBe(true);
    });
});

// A step awaiting a request or a browser API that never settles (the service worker's `ready` on a
// failed install) must not freeze the supervisor: every later repair would join the stuck pass.
describe('createConnectionSupervisor — a step that never settles', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('gives the step up after its deadline, so the next repair runs every step again', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const steps = fakeSteps({ registerPush: hangs<boolean>() });
        const supervisor = createConnectionSupervisor(steps);

        const firstPass = supervisor.repair();
        // The hanging step is reached a few awaits into the pass; its deadline starts from there.
        await vi.advanceTimersByTimeAsync(0);
        expect(steps.registerPush).toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(REPAIR_STEP_DEADLINE_MS);
        await firstPass;
        // The second pass reaches the hanging step again; its earlier steps are what this is about.
        void supervisor.repair();
        await vi.advanceTimersByTimeAsync(0);

        expect(steps.syncIfBehind).toHaveBeenCalledTimes(2);
        expect(steps.ensureLiveChannels.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('never lets a step that finishes after the network was lost count as done for the next spell', async () => {
        const cookie = deferred<boolean>();
        const steps = fakeSteps({ reconcileSessionCookie: vi.fn().mockImplementationOnce(() => cookie.promise) });
        const supervisor = createConnectionSupervisor(steps);

        const pass = supervisor.repair();
        await vi.waitFor(() => expect(steps.reconcileSessionCookie).toHaveBeenCalledTimes(1));
        supervisor.forgetSessionSteps();
        cookie.resolve(true);
        await pass;
        await supervisor.repair();

        expect(steps.reconcileSessionCookie).toHaveBeenCalledTimes(2);
    });
});

describe('nextSyncAction', () => {
    const idle = { isSyncing: false, isCatchingUp: false, hasFullSyncSucceeded: false, isCaughtUp: false };

    it('runs the full sync until one has succeeded', () => {
        expect(nextSyncAction(idle)).toBe('fullSync');
    });

    it('then only catches up, and only while behind', () => {
        expect(nextSyncAction({ ...idle, hasFullSyncSucceeded: true })).toBe('catchUp');
        expect(nextSyncAction({ ...idle, hasFullSyncSucceeded: true, isCaughtUp: true })).toBe('none');
    });

    // Two orchestrator passes at once overlap past the session gate's timeout on a slow link — a
    // second bootstrap, cookie pivots under the first pass. The running one covers the request.
    it('starts nothing while a full sync or a catch-up is already running', () => {
        expect(nextSyncAction({ ...idle, isSyncing: true })).toBe('none');
        expect(nextSyncAction({ ...idle, isCatchingUp: true })).toBe('none');
        expect(nextSyncAction({ ...idle, hasFullSyncSucceeded: true, isCatchingUp: true })).toBe('none');
    });
});
