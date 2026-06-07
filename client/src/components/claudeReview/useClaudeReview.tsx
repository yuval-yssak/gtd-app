import { type ReactNode, useCallback, useState } from 'react';
import type { StoredItem, StoredPerson, StoredWorkContext } from '../../types/MyDB';
import { ClaudeReviewSheet } from './ClaudeReviewSheet';

interface UseClaudeReviewOptions {
    people: StoredPerson[];
    workContexts: StoredWorkContext[];
    /** Pulls the server-side applied write back into IDB. Wired to syncAndRefresh by the host page. */
    onApplied: () => Promise<void>;
    /**
     * Pins the Better Auth session to the reviewed item's owner for the assist/apply calls. The item
     * may belong to a non-active signed-in account; without this pivot the server rejects the request
     * (404 not_found / 403 forbidden). Wired to AppData's `withOwnerSession` by the host page.
     */
    withOwnerSession: <T>(userId: string, task: () => Promise<T>) => Promise<T>;
}

export interface ClaudeReviewAPI {
    openFor: (item: StoredItem) => void;
    /** The host page renders this at root; emits the review sheet when an item is open. */
    renderGlobal: () => ReactNode;
    isOpen: boolean;
}

/**
 * Host hook for the Claude review sheet — mirrors `useItemEditor`'s openFor/renderGlobal ergonomics
 * so a page wires the Claude affordance the same way it wires the editor. Owns only which item (if
 * any) is under review; the sheet itself owns the proposal/apply state.
 */
export function useClaudeReview({ people, workContexts, onApplied, withOwnerSession }: UseClaudeReviewOptions): ClaudeReviewAPI {
    const [item, setItem] = useState<StoredItem | null>(null);
    const openFor = useCallback((next: StoredItem) => setItem(next), []);
    const close = useCallback(() => setItem(null), []);

    const renderGlobal = useCallback((): ReactNode => {
        if (!item) {
            return null;
        }
        return (
            <ClaudeReviewSheet
                key={item._id}
                item={item}
                people={people}
                workContexts={workContexts}
                onClose={close}
                onApplied={onApplied}
                withOwnerSession={withOwnerSession}
            />
        );
    }, [item, people, workContexts, close, onApplied, withOwnerSession]);

    return { openFor, renderGlobal, isOpen: item !== null };
}
