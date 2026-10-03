import { APP_NAME } from './appName';

/**
 * Browser-tab title for a page: "Inbox · Done" on a page, plain "Done" where there is no page
 * name (the landing page, or a blank page name).
 */
export function formatPageTitle(pageTitle: string | undefined) {
    const trimmed = pageTitle?.trim();
    return trimmed ? `${trimmed} · ${APP_NAME}` : APP_NAME;
}
