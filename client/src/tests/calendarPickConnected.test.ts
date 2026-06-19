import { describe, expect, it } from 'vitest';
import type { CalendarIntegration } from '../api/calendarApi';
import { isStaleIntegrationError, pickConnectedIntegration } from '../components/settings/CalendarIntegrations';
import type { IntegrationWithDetails } from '../data/calendarIntegrationsResource';
import type { NonEmptyArray } from '../lib/typeUtils';

function detail(id: string, createdTs: string): IntegrationWithDetails {
    const integration = { _id: id, provider: 'google', createdTs, updatedTs: createdTs } as unknown as CalendarIntegration;
    return { integration, syncConfigs: [], calendars: [] };
}

/**
 * `pickConnectedIntegration` is the guard against the disconnect/reconnect 404: the post-OAuth picker
 * must open against the integration id the server actually persisted (carried in the `calendarConnected`
 * redirect param), not whichever row a stale resource cache happened to hold.
 */
describe('pickConnectedIntegration', () => {
    it('selects the row whose _id matches the persisted connected id', () => {
        const details: NonEmptyArray<IntegrationWithDetails> = [detail('int-old', '2026-06-18T00:00:00.000Z'), detail('int-new', '2026-06-19T00:00:00.000Z')];
        // The newest is int-new, but the redirect named int-old — id match must win over recency.
        expect(pickConnectedIntegration(details, 'int-old').integration._id).toBe('int-old');
    });

    it('falls back to the newest-by-createdTs row when the connected id matches nothing (legacy "1" redirect)', () => {
        const details: NonEmptyArray<IntegrationWithDetails> = [detail('int-a', '2026-06-18T00:00:00.000Z'), detail('int-b', '2026-06-19T00:00:00.000Z')];
        expect(pickConnectedIntegration(details, '1').integration._id).toBe('int-b');
    });

    it('returns the sole row regardless of the connected id', () => {
        const details: NonEmptyArray<IntegrationWithDetails> = [detail('only', '2026-06-18T00:00:00.000Z')];
        expect(pickConnectedIntegration(details, 'whatever').integration._id).toBe('only');
    });

    it('on equal createdTs (no id match), keeps the later-listed row — pins the reduce tie-break', () => {
        const ts = '2026-06-18T00:00:00.000Z';
        const details: NonEmptyArray<IntegrationWithDetails> = [detail('first', ts), detail('second', ts)];
        expect(pickConnectedIntegration(details, '1').integration._id).toBe('second');
    });
});

describe('isStaleIntegrationError', () => {
    it('is true for an apiFetch 404 error (stale integration id)', () => {
        expect(isStaleIntegrationError(new Error('Calendar API error 404: {"error":"Integration not found"}'))).toBe(true);
    });

    it('is false for a 409 conflict (calendar already synced) and non-Errors', () => {
        expect(isStaleIntegrationError(new Error('Calendar API error 409: already synced'))).toBe(false);
        expect(isStaleIntegrationError('404')).toBe(false);
        expect(isStaleIntegrationError(null)).toBe(false);
    });
});
