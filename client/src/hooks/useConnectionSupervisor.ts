import { useEffect, useMemo, useRef } from 'react';
import { type ConnectionRepairSteps, createConnectionSupervisor } from '../lib/connectionSupervisor';
import { createRepairRetrier } from '../lib/repairRetrier';
import { subscribeToSyncFreshness } from '../lib/syncFreshness';

/**
 * Keeps the device connected while the browser says online: a repair pass runs at once (on mount
 * and on every return online), then again on a backoff until nothing is left to repair, and again
 * whenever freshness changes (a pull failed, the network dropped). See lib/connectionSupervisor.ts.
 */
export function useConnectionSupervisor(isOnline: boolean, steps: ConnectionRepairSteps): void {
    // The supervisor's progress (which steps are done) must outlive re-renders, so it is created once
    // and reads the latest step implementations through this ref.
    const latestSteps = useRef(steps);
    useEffect(() => {
        latestSteps.current = steps;
    });
    const supervisor = useMemo(() => createConnectionSupervisor(delegateTo(latestSteps)), []);

    useEffect(() => {
        if (!isOnline) {
            supervisor.forgetSessionSteps();
            return;
        }
        void supervisor.repair();
        const retrier = createRepairRetrier({ repair: () => void supervisor.repair(), isRepaired: supervisor.isRepaired });
        retrier.ensureRunning();
        const unsubscribe = subscribeToSyncFreshness(retrier.ensureRunning);
        return () => {
            unsubscribe();
            retrier.stop();
        };
    }, [isOnline, supervisor]);
}

/** Steps that forward to whatever the ref holds when each is called. */
function delegateTo(stepsRef: { readonly current: ConnectionRepairSteps }): ConnectionRepairSteps {
    return {
        ensureLiveChannels: () => stepsRef.current.ensureLiveChannels(),
        areLiveChannelsUp: () => stepsRef.current.areLiveChannelsUp(),
        seedAccounts: () => stepsRef.current.seedAccounts(),
        reconcileSessionCookie: () => stepsRef.current.reconcileSessionCookie(),
        registerPush: () => stepsRef.current.registerPush(),
        syncIfBehind: () => stepsRef.current.syncIfBehind(),
        isCaughtUp: () => stepsRef.current.isCaughtUp(),
    };
}
