import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import {
    type ClaudeRoutineConnectionView,
    disconnectClaudeRoutine,
    fetchClaudeRoutineConnection,
    saveClaudeRoutineConnection,
} from '../../api/claudeRoutineApi';
import { useAppData } from '../../contexts/AppDataProvider';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useOnline } from '../../hooks/useOnline';
import { type ConnectionDraft, describeConnectionError, describeLoadError } from './claudeRoutineSectionLogic';

/** The Settings section's view of the active account's Claude routine and its actions. */
export interface ClaudeRoutineConnectionState {
    /** `null` while the first read for the current account is in flight (or failed). */
    connection: ClaudeRoutineConnectionView | null;
    loadError: string | null;
    actionError: string | null;
    isPending: boolean;
    isOnline: boolean;
    /** The connected view swapped for the form, to paste a new Claude routine over the old one. */
    isReplacing: boolean;
    startReplacing: () => void;
    cancelReplacing: () => void;
    retryLoad: () => void;
    save: (draft: ConnectionDraft) => Promise<boolean>;
    disconnect: () => void;
}

/**
 * Reads and writes the ACTIVE account's Claude routine. Every call is pinned with
 * `withActiveAccountSession`: the cookie can drift to another signed-in account, and storing the
 * work Claude routine on the personal account would start the wrong Claude account's sessions.
 */
export function useClaudeRoutineConnection(): ClaudeRoutineConnectionState {
    const { account, withActiveAccountSession } = useAppData();
    const accountId = account?.id;
    const isOnline = useOnline();
    const isMounted = useIsMounted();
    const [connection, setConnection] = useState<ClaudeRoutineConnectionView | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [isReplacing, setIsReplacing] = useState(false);
    const [isPending, startTransition] = useTransition();
    // A response that lands after an account switch belongs to the previous account — drop it.
    const currentAccountIdRef = useRef(accountId);
    // Declared before the load effect so the ref already names the new account when it runs.
    useEffect(() => {
        currentAccountIdRef.current = accountId;
    }, [accountId]);

    // Account switch: forget the previous account's view during render (no flash of its id).
    const [shownAccountId, setShownAccountId] = useState(accountId);
    if (shownAccountId !== accountId) {
        setShownAccountId(accountId);
        setConnection(null);
        setLoadError(null);
        setActionError(null);
        setIsReplacing(false);
    }

    const adopt = useCallback(
        (forAccountId: string | undefined, view: ClaudeRoutineConnectionView) => {
            if (!isMounted() || currentAccountIdRef.current !== forAccountId) {
                return;
            }
            setConnection(view);
            // Disconnected (here or elsewhere): there is nothing left to replace.
            if (!view.connected) {
                setIsReplacing(false);
            }
        },
        [isMounted],
    );

    const load = useCallback(async () => {
        const forAccountId = currentAccountIdRef.current;
        setLoadError(null);
        try {
            adopt(forAccountId, await withActiveAccountSession(() => fetchClaudeRoutineConnection()));
        } catch (err) {
            if (isMounted() && currentAccountIdRef.current === forAccountId) {
                setLoadError(describeLoadError(err));
            }
        }
    }, [withActiveAccountSession, isMounted, adopt]);

    // Re-read on account switch and when the connection comes back (the first read may have run offline).
    useEffect(() => {
        if (!accountId || !isOnline) {
            return;
        }
        void load();
    }, [accountId, isOnline, load]);

    async function runAction(action: () => Promise<ClaudeRoutineConnectionView>): Promise<boolean> {
        const forAccountId = currentAccountIdRef.current;
        setActionError(null);
        try {
            adopt(forAccountId, await withActiveAccountSession(action));
            return true;
        } catch (err) {
            if (isMounted()) {
                setActionError(describeConnectionError(err));
            }
            return false;
        }
    }

    function save(draft: ConnectionDraft): Promise<boolean> {
        return new Promise((resolve) => {
            startTransition(async () => {
                const isSaved = await runAction(() =>
                    saveClaudeRoutineConnection({ claudeRoutineId: draft.claudeRoutineId.trim(), token: draft.token.trim() }),
                );
                if (isSaved && isMounted()) {
                    setIsReplacing(false);
                }
                resolve(isSaved);
            });
        });
    }

    function disconnect() {
        startTransition(async () => {
            await runAction(() => disconnectClaudeRoutine());
        });
    }

    return {
        connection,
        loadError,
        actionError,
        isPending,
        isOnline,
        isReplacing,
        startReplacing: () => setIsReplacing(true),
        cancelReplacing: () => setIsReplacing(false),
        retryLoad: () => void load(),
        save,
        disconnect,
    };
}
