import dayjs from 'dayjs';
import calendarIntegrationsDAO from '../dataAccess/calendarIntegrationsDAO.js';
import calendarSyncConfigsDAO from '../dataAccess/calendarSyncConfigsDAO.js';
import { buildProvider, renewWebhookAndCatchUp } from '../routes/calendar.js';
import type { CalendarSyncConfigInterface } from '../types/entities.js';
import { integrationStatus } from './calendarIntegrationStatus.js';

const RENEWAL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

type RenewalOutcome = 'renewed' | 'skipped' | 'failed';

export interface RenewalSummary {
    renewed: number;
    failed: number;
}

/** Periodically checks for expiring webhook channels and renews them. Designed for environments without Cloud Scheduler. */
export function startWebhookRenewalTimer(): NodeJS.Timeout {
    console.log('[webhook-renewal] starting renewal timer (every 1h)');
    // Run immediately on startup, then every hour.
    renewOnTimerTick();
    return setInterval(renewOnTimerTick, RENEWAL_INTERVAL_MS);
}

/** Nothing awaits a timer tick, so a sweep-level failure (e.g. Mongo down) must be caught here or it crashes the process. */
function renewOnTimerTick() {
    renewAllExpiring().catch((err) => {
        console.error('[webhook-renewal] sweep failed', { err });
    });
}

let renewing = false;

/**
 * Renews every webhook channel expiring within a day — the single sweep behind both the dev timer and
 * `POST /calendar/webhooks/renew` (Cloud Scheduler). A per-config failure is error-logged and counted;
 * a sweep-level failure rejects so the cron route answers 500 instead of a misleading 200.
 */
export async function renewAllExpiring(): Promise<RenewalSummary> {
    if (renewing) {
        return { renewed: 0, failed: 0 };
    }
    renewing = true;
    try {
        const configs = await calendarSyncConfigsDAO.findNeedingWebhook(dayjs().add(1, 'day').toISOString());
        const summary = summarize(await renewSequentially(configs));
        if (configs.length > 0) {
            console.log('[webhook-renewal] processed configs', { total: configs.length, ...summary });
        }
        return summary;
    } finally {
        renewing = false;
    }
}

/** Sequential to avoid overwhelming Google's API with parallel requests per-account. */
async function renewSequentially(configs: CalendarSyncConfigInterface[]) {
    const outcomes: RenewalOutcome[] = [];
    for (const config of configs) {
        outcomes.push(await renewConfig(config));
    }
    return outcomes;
}

/** Per-config try/catch isolates a broken integration (e.g. revoked refresh token) from blocking renewal of the rest. */
async function renewConfig(config: CalendarSyncConfigInterface): Promise<RenewalOutcome> {
    try {
        const integration = await calendarIntegrationsDAO.findByOwnerAndIdDecrypted(config.integrationId, config.user);
        if (!integration) {
            return 'skipped';
        }
        // Skip suspended/revoked — the auth-escalation flow owns their lifecycle. Hitting
        // Google again would just re-trigger the same `invalid_grant` on every renewal tick.
        if (integrationStatus(integration) !== 'active') {
            console.log('[webhook-renewal] skipping inactive integration', { integrationId: integration._id, status: integrationStatus(integration) });
            return 'skipped';
        }
        await renewWebhookAndCatchUp(config, integration, buildProvider(integration, config.user));
        return 'renewed';
    } catch (err) {
        console.error('[webhook-renewal] renewal failed', { configId: config._id, integrationId: config.integrationId, err });
        return 'failed';
    }
}

function summarize(outcomes: RenewalOutcome[]): RenewalSummary {
    return {
        renewed: outcomes.filter((outcome) => outcome === 'renewed').length,
        failed: outcomes.filter((outcome) => outcome === 'failed').length,
    };
}
