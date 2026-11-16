// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConnectionSupervisor } from '../hooks/useConnectionSupervisor';
import type { ConnectionRepairSteps } from '../lib/connectionSupervisor';
import { REPAIR_RETRY_DELAYS_MS } from '../lib/repairRetrier';
import { _resetSyncFreshnessForTests, notifySyncQueueChanged } from '../lib/syncFreshness';

const [FIRST_RETRY_MS = 0] = REPAIR_RETRY_DELAYS_MS;

/** Steps that all succeed, with a hand-flipped "caught up" so a test decides when repair is done. */
function fakeSteps() {
    const health = { caughtUp: true };
    const steps = {
        ensureLiveChannels: vi.fn(async () => undefined),
        areLiveChannelsUp: vi.fn(() => true),
        seedAccounts: vi.fn(async () => true),
        reconcileSessionCookie: vi.fn(async () => true),
        registerPush: vi.fn(async () => true),
        syncIfBehind: vi.fn(),
        isCaughtUp: vi.fn(() => health.caughtUp),
    } satisfies ConnectionRepairSteps;
    return { steps, health };
}

function Supervised({ isOnline, steps }: { isOnline: boolean; steps: ConnectionRepairSteps }) {
    useConnectionSupervisor(isOnline, steps);
    return null;
}

/** Lets the repair pass's awaits settle under fake timers. */
async function settle() {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
    });
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    _resetSyncFreshnessForTests();
});

describe('useConnectionSupervisor', () => {
    it('repairs at once on mount while online', async () => {
        const { steps } = fakeSteps();

        render(<Supervised isOnline steps={steps} />);
        await settle();

        expect(steps.ensureLiveChannels).toHaveBeenCalled();
        expect(steps.syncIfBehind).toHaveBeenCalledTimes(1);
    });

    it('does nothing while the browser reports offline', async () => {
        const { steps } = fakeSteps();

        render(<Supervised isOnline={false} steps={steps} />);
        await settle();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS * 4);
        });

        expect(steps.ensureLiveChannels).not.toHaveBeenCalled();
    });

    it('checks the session cookie again on the way back online — an offline account switch leaves it behind', async () => {
        const { steps } = fakeSteps();
        const view = render(<Supervised isOnline steps={steps} />);
        await settle();

        view.rerender(<Supervised isOnline={false} steps={steps} />);
        view.rerender(<Supervised isOnline steps={steps} />);
        await settle();

        expect(steps.reconcileSessionCookie).toHaveBeenCalledTimes(2);
        expect(steps.seedAccounts).toHaveBeenCalledTimes(1);
    });

    it('starts retrying again when freshness changes after the connection was repaired', async () => {
        const { steps, health } = fakeSteps();
        render(<Supervised isOnline steps={steps} />);
        await settle();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS * 4);
        });
        expect(steps.syncIfBehind).toHaveBeenCalledTimes(1);

        health.caughtUp = false;
        act(() => notifySyncQueueChanged());
        await act(async () => {
            await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);
        });

        expect(steps.syncIfBehind).toHaveBeenCalledTimes(2);
    });

    it('stops retrying once unmounted', async () => {
        const { steps, health } = fakeSteps();
        health.caughtUp = false;
        const view = render(<Supervised isOnline steps={steps} />);
        await settle();

        view.unmount();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS * 4);
        });

        expect(steps.syncIfBehind).toHaveBeenCalledTimes(1);
    });
});
