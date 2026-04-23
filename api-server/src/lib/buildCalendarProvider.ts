import { GoogleCalendarProvider } from '../calendarProviders/GoogleCalendarProvider.js';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import type { CalendarIntegrationInterface } from '../types/entities.js';

/** Creates a GoogleCalendarProvider that persists refreshed tokens back to MongoDB. */
export function buildCalendarProvider(integration: CalendarIntegrationInterface, userId: string): GoogleCalendarProvider {
    return new GoogleCalendarProvider(integration, (accessToken, refreshToken, expiry) =>
        calendarIntegrationsDAO.updateTokens({ id: integration._id, userId, accessToken, refreshToken, tokenExpiry: expiry }),
    );
}
