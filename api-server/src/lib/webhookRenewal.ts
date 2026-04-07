import dayjs from 'dayjs';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import { buildProvider, renewWebhookIfExpired } from '../routes/calendar.js';

const RENEWAL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/** Periodically checks for expiring webhook channels and renews them. Designed for environments without Cloud Scheduler. */
export function startWebhookRenewalTimer(): NodeJS.Timeout {
    console.log('[webhook-renewal] starting renewal timer (every 1h)');
    // Run immediately on startup, then every hour.
    renewAllExpiring();
    return setInterval(renewAllExpiring, RENEWAL_INTERVAL_MS);
}

let renewing = false;

async function renewAllExpiring(): Promise<void> {
    if (renewing) {
        return;
    }
    renewing = true;
    try {
        const horizon = dayjs().add(1, 'day').toISOString();
        const configs = await calendarSyncConfigsDAO.findNeedingWebhook(horizon);
        // Sequential to avoid overwhelming Google's API with parallel requests per-account.
        for (const config of configs) {
            const integration = await calendarIntegrationsDAO.findByOwnerAndIdDecrypted(config.integrationId, config.user);
            if (!integration) {
                continue;
            }
            const provider = buildProvider(integration, config.user);
            await renewWebhookIfExpired(config, provider);
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
