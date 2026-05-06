import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { isTokenUnused, UNUSED_THRESHOLD_DAYS } from '../components/settings/PersonalApiTokens';

const now = dayjs('2026-05-06T12:00:00.000Z');

describe('isTokenUnused', () => {
    it('returns true when lastUsedTs is missing — never-used tokens are the safest to revoke', () => {
        expect(isTokenUnused({ id: '1', label: 'a', createdTs: '2026-01-01T00:00:00.000Z', scopes: ['items.capture', 'items.read'] }, now)).toBe(true);
    });

    it(`returns true when lastUsedTs is older than ${UNUSED_THRESHOLD_DAYS} days`, () => {
        const cutoff = now.subtract(UNUSED_THRESHOLD_DAYS + 1, 'day').toISOString();
        expect(
            isTokenUnused({ id: '1', label: 'a', createdTs: '2026-01-01T00:00:00.000Z', scopes: ['items.capture', 'items.read'], lastUsedTs: cutoff }, now),
        ).toBe(true);
    });

    it(`returns false when lastUsedTs is exactly under the ${UNUSED_THRESHOLD_DAYS}-day window`, () => {
        const recent = now.subtract(UNUSED_THRESHOLD_DAYS - 1, 'day').toISOString();
        expect(
            isTokenUnused({ id: '1', label: 'a', createdTs: '2026-01-01T00:00:00.000Z', scopes: ['items.capture', 'items.read'], lastUsedTs: recent }, now),
        ).toBe(false);
    });

    it('returns false when the token is revoked (no point chipping it as unused)', () => {
        const veryOld = now.subtract(365, 'day').toISOString();
        expect(
            isTokenUnused(
                {
                    id: '1',
                    label: 'a',
                    createdTs: '2025-01-01T00:00:00.000Z',
                    scopes: ['items.capture', 'items.read'],
                    lastUsedTs: veryOld,
                    revokedTs: '2026-04-01T00:00:00.000Z',
                },
                now,
            ),
        ).toBe(false);
    });

    it('uses ≥ comparison: a token whose lastUsedTs is exactly the threshold is unused', () => {
        const exactlyThreshold = now.subtract(UNUSED_THRESHOLD_DAYS, 'day').toISOString();
        expect(
            isTokenUnused(
                { id: '1', label: 'a', createdTs: '2026-01-01T00:00:00.000Z', scopes: ['items.capture', 'items.read'], lastUsedTs: exactlyThreshold },
                now,
            ),
        ).toBe(true);
    });
});
