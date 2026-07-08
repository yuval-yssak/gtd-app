import { useDeferredValue, useEffect, useState } from 'react';

const QUERY_DEBOUNCE_MS = 200;

interface ListSearchOptions {
    /** Current `q` from the URL ('' when unset). */
    urlQuery: string;
    /** Writes `q` back to the URL (with replace: true). Must be referentially stable (useCallback). */
    writeUrlQuery: (query: string) => void;
}

/**
 * Search-field state for list pages: keystrokes commit urgently to `queryInput` (so the input
 * echoes immediately), filtering keys off `deferredQuery` so the list re-render happens in a
 * background render React can interrupt, and the URL receives the query via a debounced write
 * for shareability/history only — the same pipeline the /search page uses.
 *
 * `isOpen` drives the collapsible field on pages where search hides behind a header button;
 * it starts open when the page is entered through a shared/bookmarked `?q=` URL.
 */
export function useListSearch({ urlQuery, writeUrlQuery }: ListSearchOptions) {
    const [queryInput, setQueryInput] = useState(urlQuery);
    const [isOpen, setIsOpen] = useState(urlQuery !== '');
    const deferredQuery = useDeferredValue(queryInput);

    // Debounce query → URL. Skip the write on no-op so typing doesn't churn history.
    useEffect(() => {
        if (queryInput === urlQuery) {
            return;
        }
        const handle = window.setTimeout(() => writeUrlQuery(queryInput), QUERY_DEBOUNCE_MS);
        return () => window.clearTimeout(handle);
    }, [queryInput, urlQuery, writeUrlQuery]);

    // External URL changes (back/forward, programmatic resets) need to flow back into the input.
    // setState dedupes when the value matches, so unconditionally calling it is safe and avoids
    // a stale-closure read of queryInput inside a comparison.
    useEffect(() => {
        setQueryInput(urlQuery);
    }, [urlQuery]);

    function closeSearch() {
        setIsOpen(false);
        setQueryInput('');
        // Immediate (not debounced) so the URL never keeps a stale q after the field is gone.
        if (urlQuery !== '') {
            writeUrlQuery('');
        }
    }

    return {
        isOpen,
        toggleSearch: () => (isOpen ? closeSearch() : setIsOpen(true)),
        closeSearch,
        queryInput,
        setQueryInput,
        deferredQuery,
    };
}
