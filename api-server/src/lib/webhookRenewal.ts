import dayjs from 'dayjs';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import { buildProvider, renewWebhookIfExpired } from '../routes/calendar.js';
import { integrationStatus } from './calendarIntegrationStatus.js';

const RENEWAL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/** Periodically checks for expiring webhook channels and renews them. Designed for environments without Cloud Scheduler. */
export function startWebhookRenewalTimer(): NodeJS.Timeout {
    console.log('[webhook-renewal] starting renewal timer (every 1h)');
    // Run immediately on startup, then every hour.
    renewAllExpiring();
    return setInterval(renewAllExpiring, RENEWAL_INTERVAL_MS);
}

let renewing = false;

/** Exported for tests so they can drive the renewal sweep deterministically without timers. */
export async function renewAllExpiring(): Promise<void> {
    if (renewing) {
        return;
    }
    renewing = true;
    try {
        const horizon = dayjs().add(1, 'day').toISOString();
        const configs = await calendarSyncConfigsDAO.findNeedingWebhook(horizon);
        // Sequential to avoid overwhelming Google's API with parallel requests per-account.
        // Per-config try/catch isolates a broken integration (e.g. revoked refresh token, stale
        // dev fixtures with `dev-rt-plaintext`) from blocking renewal of the rest.
        for (const config of configs) {
            try {
                const integration = await calendarIntegrationsDAO.findByOwnerAndIdDecrypted(config.integrationId, config.user);
                if (!integration) {
                    continue;
                }
                // Skip suspended/revoked — the auth-escalation flow owns their lifecycle. Hitting
                // Google again would just re-trigger the same `invalid_grant` on every renewal tick.
                if (integrationStatus(integration) !== 'active') {
                    console.log(`[webhook-renewal] skipping ${integrationStatus(integration)} integration ${integration._id}`);
                    continue;
                }
                const provider = buildProvider(integration, config.user);
                await renewWebhookIfExpired(config, provider, integration._id);
            } catch (err) {
                console.error(`[webhook-renewal] skipping config ${config._id} (integration ${config.integrationId}):`, err);
            }
        }
        if (configs.length > 0) {
            console.log(`[webhook-renewal] processed ${configs.length} configs`);
        }
    } catch (err) {
        console.error('[webhook-renewal] timer failed:', err);
    } finally {
        renewing = false;
    }
}
