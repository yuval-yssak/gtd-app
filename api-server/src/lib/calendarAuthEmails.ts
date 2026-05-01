import dayjs from 'dayjs';
import type { CalendarIntegrationInterface } from '../types/entities.js';

interface BuiltEmail {
    subject: string;
    body: string;
}

/**
 * Warning email — sent when a Google Calendar integration first hits `invalid_grant`. Tells the
 * user they have ~24h to reconnect before the integration is auto-disconnected. Plain text only;
 * HTML templating belongs with the real email provider.
 */
export function buildCalendarAuthWarningEmail(integration: CalendarIntegrationInterface, gracePeriodEndsAt: string): BuiltEmail {
    const friendlyDeadline = dayjs(gracePeriodEndsAt).format('YYYY-MM-DD HH:mm UTC');
    const body = [
        'Hi,',
        '',
        `We can no longer access your ${integration.provider === 'google' ? 'Google Calendar' : integration.provider} account.`,
        'This usually happens when you revoke access, change your password, or the connection has been idle too long.',
        '',
        `If you do not reconnect by ${friendlyDeadline} (about 24 hours from now), the integration will be disconnected automatically.`,
        'Your calendar items will remain in the app, but they will stop syncing until you reconnect.',
        '',
        'To reconnect: open Settings → Calendar Integrations and click "Reconnect" on the affected account.',
        '',
        'Thanks,',
        'GTD',
    ].join('\n');
    return {
        subject: 'Action required: reconnect your Google Calendar',
        body,
    };
}

/**
 * Final email — sent when the 24h grace period has elapsed and the integration was auto-revoked.
 * Reassures the user that calendar items are preserved locally and explains the reconnect path.
 */
export function buildCalendarAuthRevokedEmail(integration: CalendarIntegrationInterface): BuiltEmail {
    const body = [
        'Hi,',
        '',
        `Your ${integration.provider === 'google' ? 'Google Calendar' : integration.provider} integration has been disconnected because we could not refresh access to your account within 24 hours.`,
        '',
        'Your existing calendar items remain in the app, but they will not sync with Google Calendar until you reconnect.',
        '',
        'To reconnect: open Settings → Calendar Integrations and connect the same account again.',
        '',
        'Thanks,',
        'GTD',
    ].join('\n');
    return {
        subject: 'Your Google Calendar integration was disconnected',
        body,
    };
}
