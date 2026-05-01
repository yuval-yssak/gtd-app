import type { CalendarIntegrationInterface } from '../types/entities.js';

/**
 * Coerces a missing `status` field to `'active'`. Existing integration rows pre-date the auth
 * escalation feature and have no `status` field — read sites must always go through this helper
 * so legacy rows behave identically to freshly-`upsertEncrypted` ones.
 */
export function integrationStatus(integration: Pick<CalendarIntegrationInterface, 'status'>): 'active' | 'suspended' | 'revoked' {
    return integration.status ?? 'active';
}
