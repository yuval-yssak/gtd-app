import type { IDBPDatabase } from 'idb';
import { useRef, useState } from 'react';
import { askClaude } from '../../api/claudeRoutineApi';
import { useAppData } from '../../contexts/AppDataProvider';
import { applyServerClaudeAsk } from '../../db/syncHelpers';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useOnline } from '../../hooks/useOnline';
import type { MyDB, StoredItem } from '../../types/MyDB';
import { type AskErrorView, describeAskButton } from './askClaudeLogic';
import { type AskClaudeSettlement, runAskClaude } from './askClaudeRunner';

/** What the Ask Claude section needs from its host: the draft, the send state, and the feedback. */
export interface AskClaudeState {
    prompt: string;
    /** Editing the prompt also clears the last error — the user is acting on it. */
    setPrompt: (next: string) => void;
    isSending: boolean;
    isOnline: boolean;
    /** The last failure, until the prompt is edited or the next send starts. */
    error: AskErrorView | null;
    /** The session the last successful send started — drives the "working on it" toast. */
    startedSessionUrl: string | null;
    dismissStarted: () => void;
    submit: () => void;
}

interface AskClaudeTarget {
    item: Pick<StoredItem, '_id' | 'userId'>;
    /** The host owns the editor's autosave, so it supplies the flush (see `AskClaudeRunPorts`). */
    flushItemText: () => Promise<void>;
}

/**
 * Drives the "Ask Claude" box for one item. The round trip lives in `runAskClaude` (plain,
 * unit-tested); this hook owns the draft/feedback state and the ports: owner-session pinning,
 * the LWW local apply, and the provider refresh.
 */
export function useAskClaude(db: IDBPDatabase<MyDB>, { item, flushItemText }: AskClaudeTarget): AskClaudeState {
    const { withOwnerSession, refreshClaudeAsks } = useAppData();
    const isOnline = useOnline();
    const isMounted = useIsMounted();
    const [prompt, setPromptState] = useState('');
    const [isSending, setIsSending] = useState(false);
    const [error, setError] = useState<AskErrorView | null>(null);
    const [startedSessionUrl, setStartedSessionUrl] = useState<string | null>(null);
    // State updates are async, so a Mod+Enter and a click in the same frame would both see
    // isSending=false; the ref closes that window (the server's in-flight guard is the backstop).
    const isSendingRef = useRef(false);

    function applySettlement(settlement: AskClaudeSettlement) {
        setIsSending(false);
        if (settlement.kind === 'started') {
            setPromptState('');
            setStartedSessionUrl(settlement.sessionUrl);
            return;
        }
        setError(settlement.error);
    }

    async function send(text: string) {
        isSendingRef.current = true;
        setIsSending(true);
        setError(null);
        const settlement = await runAskClaude(text, {
            flushItemText,
            // Pivot to the item's OWNER: the route acts as the session user, and it is the owner's
            // Claude routine that must start (a work item → the work Claude account).
            ask: (trimmed) => withOwnerSession(item.userId, () => askClaude(item._id, trimmed)),
            store: async (row) => {
                await applyServerClaudeAsk(db, row);
                await refreshClaudeAsks();
            },
        });
        isSendingRef.current = false;
        if (isMounted()) {
            applySettlement(settlement);
        }
    }

    function submit() {
        // Same rule the button renders from, plus the same-frame double-submit ref.
        if (isSendingRef.current || describeAskButton({ isOnline, isSending, prompt }).isDisabled) {
            return;
        }
        void send(prompt);
    }

    function setPrompt(next: string) {
        setPromptState(next);
        setError(null);
    }

    return { prompt, setPrompt, isSending, isOnline, error, startedSessionUrl, dismissStarted: () => setStartedSessionUrl(null), submit };
}
