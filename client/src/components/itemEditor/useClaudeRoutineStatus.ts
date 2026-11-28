import { useEffect, useSyncExternalStore } from 'react';
import { fetchClaudeRoutineConnection } from '../../api/claudeRoutineApi';
import { useAppData } from '../../contexts/AppDataProvider';
import { useOnline } from '../../hooks/useOnline';
import { claudeRoutineStatusStore } from '../../lib/claudeRoutineStatus';

/** Whether the item OWNER's account has a Claude routine — the one an ask from this item would start. */
export function useClaudeRoutineStatus(ownerId: string) {
    const { withOwnerSession } = useAppData();
    const isOnline = useOnline();
    const status = useSyncExternalStore(claudeRoutineStatusStore.subscribe, () => claudeRoutineStatusStore.statusOf(ownerId));

    // On mount, and whenever the tab comes back into view: a page left open still picks up a
    // change made on another device once the TTL lapses (the store dedupes fresh answers).
    useEffect(() => {
        if (!isOnline) {
            return;
        }
        const refresh = () => void claudeRoutineStatusStore.refresh(ownerId, () => readIsConnected(withOwnerSession, ownerId));
        const onVisibilityChanged = () => {
            if (document.visibilityState === 'visible') refresh();
        };
        refresh();
        document.addEventListener('visibilitychange', onVisibilityChanged);
        return () => document.removeEventListener('visibilitychange', onVisibilityChanged);
    }, [ownerId, isOnline, withOwnerSession]);

    function recheck() {
        void claudeRoutineStatusStore.refresh(ownerId, () => readIsConnected(withOwnerSession, ownerId), { isForced: true });
    }

    return { status, recheck };
}

async function readIsConnected(withOwnerSession: <T>(userId: string, task: () => Promise<T>) => Promise<T>, ownerId: string) {
    const view = await withOwnerSession(ownerId, () => fetchClaudeRoutineConnection());
    return view.connected;
}
