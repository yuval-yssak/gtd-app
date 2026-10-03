import { useEffect } from 'react';
import { formatPageTitle } from '../lib/pageTitle';

/**
 * Keeps the browser tab title in step with the page. Every route component calls this with its
 * page name (entity pages pass the entity's title), so switching routes always rewrites the
 * title — no cleanup is needed, and none is wanted: a flash of the bare app name between two
 * pages would make the tab flicker.
 */
export function useDocumentTitle(pageTitle: string | undefined) {
    useEffect(() => {
        document.title = formatPageTitle(pageTitle);
    }, [pageTitle]);
}
