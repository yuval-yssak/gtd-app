/** The two inline banners the OAuth callback redirect can trigger on /settings. Rendered with
 * renderToStaticMarkup so the assertions cover the real markup the route would show; behaviour
 * (query-param dismiss) is covered by e2e/calendar-connect-oauth.spec.ts. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConnectMismatchError, ScopeMissingError } from '../components/settings/CalendarIntegrations';

describe('ScopeMissingError', () => {
    it('explains that a partial grant was rejected, with a Dismiss action', () => {
        const html = renderToStaticMarkup(<ScopeMissingError onDismiss={() => {}} />);
        expect(html).toContain('data-testid="calendarScopeMissingError"');
        expect(html).toContain('some permissions were unticked');
        expect(html).toContain('all three calendar permissions');
        expect(html).toContain('Dismiss');
    });
});

describe('ConnectMismatchError', () => {
    it('keeps its account-mismatch wording — the two banners must stay distinguishable', () => {
        const html = renderToStaticMarkup(<ConnectMismatchError onDismiss={() => {}} />);
        expect(html).toContain('connect that Google Calendar account');
        expect(html).not.toContain('permissions were unticked');
    });
});
