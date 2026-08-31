/**
 * `lib/userTimezone.ts` — the server's source of the user's local calendar day. Server-side
 * routine-item generation stamps expectedBy/ignoreBefore on this day so the client's
 * local-midnight tickler boundary and the server agree (GTD item: tickler day-boundary fix).
 */
import dayjs from 'dayjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import deviceSyncStateDAO from '../dataAccess/deviceSyncStateDAO.js';
import { isValidIanaTimezone, localDateInTimezone, resolveUserTimezone } from '../lib/userTimezone.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';

beforeAll(async () => {
    await loadDataAccess('gtd_test');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await db.collection('deviceSyncState').deleteMany({});
});

async function seedDeviceWithTimezone(deviceId: string, userId: string, timezone: string | undefined, timezoneReportedTs: string | undefined) {
    await deviceSyncStateDAO.upsert({
        _id: `${deviceId}::${userId}`,
        deviceId,
        user: userId,
        lastSyncedTs: dayjs(0).toISOString(),
        lastSyncedId: '',
        lastSeenTs: dayjs().toISOString(),
        ...(timezone !== undefined ? { timezone } : {}),
        ...(timezoneReportedTs !== undefined ? { timezoneReportedTs } : {}),
    });
}

describe('resolveUserTimezone', () => {
    it('falls back to UTC when no device ever reported a timezone', async () => {
        await seedDeviceWithTimezone('dev-1', 'u-1', undefined, undefined);
        expect(await resolveUserTimezone('u-1')).toBe('UTC');
    });

    it('returns the single reported timezone', async () => {
        await seedDeviceWithTimezone('dev-1', 'u-1', 'Asia/Jerusalem', '2026-08-01T00:00:00.000Z');
        expect(await resolveUserTimezone('u-1')).toBe('Asia/Jerusalem');
    });

    it('two devices in two timezones: the most recent report wins', async () => {
        // The wife-on-the-laptop scenario — the account is active in two places at once. Any
        // per-user scheme must pick one; the agreed semantics are last-reporting-device-wins.
        await seedDeviceWithTimezone('laptop', 'u-1', 'Asia/Jerusalem', '2026-08-01T00:00:00.000Z');
        await seedDeviceWithTimezone('phone', 'u-1', 'America/New_York', '2026-08-02T00:00:00.000Z');
        expect(await resolveUserTimezone('u-1')).toBe('America/New_York');
    });

    it('falls back to UTC when the stored timezone is garbage (bypassed route validation)', async () => {
        // Report-time validation makes this unlikely, not impossible: a manual mongosh edit, or a
        // Node/ICU upgrade dropping an alias Intl accepted at report time. dayjs().tz('Not/AZone')
        // throws RangeError, and callers resolve the tz OUTSIDE their never-fail try blocks — so a
        // bad row must degrade here, not 500 every routine create/complete for the user.
        await seedDeviceWithTimezone('dev-1', 'u-1', 'Not/AZone', '2026-08-01T00:00:00.000Z');
        expect(await resolveUserTimezone('u-1')).toBe('UTC');
    });

    it('breaks a timezoneReportedTs tie deterministically (higher _id wins)', async () => {
        // Two devices reporting in the same millisecond must not make resolution flap between two
        // zones from call to call — Mongo's unordered find() order is not a tie-break.
        const sharedTs = '2026-08-01T00:00:00.000Z';
        await seedDeviceWithTimezone('dev-a', 'u-1', 'Pacific/Pago_Pago', sharedTs);
        await seedDeviceWithTimezone('dev-b', 'u-1', 'Pacific/Kiritimati', sharedTs);
        expect(await resolveUserTimezone('u-1')).toBe('Pacific/Kiritimati');
        expect(await resolveUserTimezone('u-1')).toBe('Pacific/Kiritimati');
    });

    it('ignores other users’ rows', async () => {
        await seedDeviceWithTimezone('dev-1', 'u-other', 'Pacific/Auckland', '2026-08-01T00:00:00.000Z');
        expect(await resolveUserTimezone('u-1')).toBe('UTC');
    });

    it('falls back to UTC after the only reporting device is reaped', async () => {
        // A relocated-then-abandoned device must not pin the user's timezone forever: once the
        // stale-device reaper removes its row, resolution degrades to the UTC fallback.
        await seedDeviceWithTimezone('dev-stale', 'u-1', 'Pacific/Kiritimati', '2026-01-01T00:00:00.000Z');
        await deviceSyncStateDAO.updateOne(
            { _id: 'dev-stale::u-1' },
            { $set: { lastSeenTs: '2026-01-01T00:00:00.000Z', lastSyncedTs: '2026-01-01T00:00:00.000Z' } },
        );
        expect(await resolveUserTimezone('u-1')).toBe('Pacific/Kiritimati');

        await deviceSyncStateDAO.deleteStaleDevices('u-1', dayjs().toISOString());
        expect(await resolveUserTimezone('u-1')).toBe('UTC');
    });
});

describe('localDateInTimezone', () => {
    it('resolves the calendar date on either side of the UTC boundary', () => {
        // 22:00Z — already "tomorrow" east of UTC+2, still "today" in the Americas.
        const instant = '2026-08-29T22:00:00.000Z';
        expect(localDateInTimezone('Asia/Jerusalem', instant)).toBe('2026-08-30');
        expect(localDateInTimezone('America/Los_Angeles', instant)).toBe('2026-08-29');
        expect(localDateInTimezone('UTC', instant)).toBe('2026-08-29');
    });
});

describe('isValidIanaTimezone', () => {
    it('accepts real IANA names and rejects garbage', () => {
        expect(isValidIanaTimezone('Asia/Jerusalem')).toBe(true);
        expect(isValidIanaTimezone('UTC')).toBe(true);
        expect(isValidIanaTimezone('Not/AZone')).toBe(false);
        expect(isValidIanaTimezone('')).toBe(false);
        expect(isValidIanaTimezone('x'.repeat(65))).toBe(false);
    });

    it('pins the broader Intl contract: offsets and legacy aliases pass too', () => {
        // Deliberately broader than strict Region/City names — dayjs.tz resolves all of these, so
        // rejecting them would only discard usable reports. A future tightening to a Region/City
        // regex must be a visible break here, not a silent behavior change.
        expect(isValidIanaTimezone('+05:00')).toBe(true);
        expect(isValidIanaTimezone('US/Pacific')).toBe(true);
        expect(isValidIanaTimezone('asia/jerusalem')).toBe(true);
    });
});
