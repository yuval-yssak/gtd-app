/** Boot-time environment guards in config.ts: the production session-secret check that index.ts
 * runs before serving, and the gate on the in-process webhook-renewal timer. Both are pure, so the
 * tests hand them env objects directly instead of stubbing process.env. */
import { describe, expect, it } from 'vitest';
import { assertSessionSecretConfiguredInProduction, shouldStartWebhookRenewalTimer } from '../config.js';

describe('assertSessionSecretConfiguredInProduction', () => {
    it('throws in production when the secret is unset', () => {
        expect(() => assertSessionSecretConfiguredInProduction({ NODE_ENV: 'production' })).toThrow(/BETTER_AUTH_SECRET/);
    });

    it('throws in production when the secret is blank — an unset GitHub secret deploys as ""', () => {
        expect(() => assertSessionSecretConfiguredInProduction({ NODE_ENV: 'production', BETTER_AUTH_SECRET: '' })).toThrow(/BETTER_AUTH_SECRET/);
    });

    it('throws in production when the secret is whitespace only', () => {
        expect(() => assertSessionSecretConfiguredInProduction({ NODE_ENV: 'production', BETTER_AUTH_SECRET: '   ' })).toThrow(/BETTER_AUTH_SECRET/);
    });

    it('passes in production once the secret is set', () => {
        expect(() => assertSessionSecretConfiguredInProduction({ NODE_ENV: 'production', BETTER_AUTH_SECRET: 's3cret' })).not.toThrow();
    });

    it('allows the dev placeholder outside production', () => {
        expect(() => assertSessionSecretConfiguredInProduction({ NODE_ENV: 'development' })).not.toThrow();
        expect(() => assertSessionSecretConfiguredInProduction({})).not.toThrow();
    });
});

describe('shouldStartWebhookRenewalTimer', () => {
    const WEBHOOK_URL = 'https://x/calendar/webhooks/google';

    it('starts the timer outside production when a webhook URL is configured, with or without a cron secret', () => {
        expect(shouldStartWebhookRenewalTimer({ NODE_ENV: 'development', CALENDAR_WEBHOOK_URL: WEBHOOK_URL })).toBe(true);
        expect(shouldStartWebhookRenewalTimer({ NODE_ENV: 'development', CALENDAR_WEBHOOK_URL: WEBHOOK_URL, CRON_SECRET: 's' })).toBe(true);
    });

    it('stops it in production once CRON_SECRET is set — Cloud Scheduler owns renewal there', () => {
        expect(shouldStartWebhookRenewalTimer({ NODE_ENV: 'production', CALENDAR_WEBHOOK_URL: WEBHOOK_URL, CRON_SECRET: 's' })).toBe(false);
    });

    it('keeps it in production while CRON_SECRET is unset or blank — no Scheduler job can renew yet', () => {
        expect(shouldStartWebhookRenewalTimer({ NODE_ENV: 'production', CALENDAR_WEBHOOK_URL: WEBHOOK_URL })).toBe(true);
        expect(shouldStartWebhookRenewalTimer({ NODE_ENV: 'production', CALENDAR_WEBHOOK_URL: WEBHOOK_URL, CRON_SECRET: '' })).toBe(true);
    });

    it('does not start it without a webhook URL', () => {
        expect(shouldStartWebhookRenewalTimer({ NODE_ENV: 'development' })).toBe(false);
        expect(shouldStartWebhookRenewalTimer({ NODE_ENV: 'production', CALENDAR_WEBHOOK_URL: '' })).toBe(false);
    });
});
