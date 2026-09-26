import { describe, expect, it } from 'vitest';
import { APP_NAME } from '../lib/appName.js';
import { buildCalendarAuthRevokedEmail, buildCalendarAuthWarningEmail } from '../lib/calendarAuthEmails.js';

// The emails sign off with the product name. "GTD" is a David Allen Company mark, so the sign-off
// must be the trademark-free name that the client and the OAuth consent screen use.

const googleIntegration = { provider: 'google' } as const;

describe('calendar auth emails', () => {
    it.each([
        ['warning', () => buildCalendarAuthWarningEmail(googleIntegration, '2026-09-28T10:00:00Z')],
        ['revoked', () => buildCalendarAuthRevokedEmail(googleIntegration)],
    ])('the %s email signs off with the product name, never the GTD mark', (_label, build) => {
        const { body } = build();
        expect(body.trimEnd()).toMatch(new RegExp(`Thanks,\\n${APP_NAME}$`));
        expect(body).not.toMatch(/\bGTD\b/);
    });
});
