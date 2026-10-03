/** Pins the contract that a transient throw from `notifyViaWebPush` cannot abort the calling
 * pipeline. Pre-fix, a Mongo blip on `pushSubscriptionsDAO.findSubscribedDevicesForUser` propagated
 * out of `notifyChange`, aborting `applyAndPublishOperation` mid-call — leaving the entity persisted
 * but, in cross-account reassign, the *target-create* leg never running (deleted on source, never
 * created on target). The fix wraps the awaited `notifyViaWebPush` leg in try/catch, logs, and
 * continues so SSE / GCal / webhook fan-out still fire and the caller still resolves.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as calendarPushback from '../lib/calendarPushback.js';
import { notifyChange, notifyChanges } from '../lib/notifyChange.js';
import * as sseConnections from '../lib/sseConnections.js';
import * as webPush from '../lib/webPush.js';
import { closeDataAccess, db, loadDataAccess } from '../loaders/mainLoader.js';
import type { OperationInterface } from '../types/entities.js';

beforeAll(async () => {
    await loadDataAccess('gtd_test');
});

afterAll(async () => {
    await closeDataAccess();
});

beforeEach(async () => {
    await Promise.all([db.collection('webhookSubscriptions').deleteMany({}), db.collection('webhookDeliveries').deleteMany({})]);
    vi.restoreAllMocks();
});

const sampleOp: OperationInterface = {
    _id: 'op-1',
    user: 'user-notify-test',
    deviceId: 'api:tok-x',
    ts: '2026-05-09T10:00:00.000Z',
    entityType: 'item',
    entityId: 'item-1',
    opType: 'create',
    snapshot: {
        _id: 'item-1',
        user: 'user-notify-test',
        status: 'inbox',
        title: 'hello',
        createdTs: '2026-05-09T10:00:00.000Z',
        updatedTs: '2026-05-09T10:00:00.000Z',
    },
};

describe('notifyChange — notifyViaWebPush failure handling', () => {
    it('swallows a thrown notifyViaWebPush, logs the error, and still fires the SSE leg', async () => {
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const sseSpy = vi.spyOn(sseConnections, 'notifyUserViaSse');
        // The pre-fix failure mode: a transient Mongo blip on the subscription lookup throws.
        vi.spyOn(webPush, 'notifyViaWebPush').mockRejectedValueOnce(new Error('mongo blip'));

        await expect(notifyChange(sampleOp)).resolves.toBeUndefined();

        // SSE fires before web push, so it should have happened regardless. Pin the contract.
        expect(sseSpy).toHaveBeenCalledTimes(1);
        // The error is logged with a recognisable prefix so ops can grep for it.
        const tag = errSpy.mock.calls.find((call) => typeof call[0] === 'string' && (call[0] as string).startsWith('[notify-change] notifyViaWebPush failed'));
        expect(tag).toBeDefined();
    });

    it('notifyChanges (batch variant) also swallows a thrown notifyViaWebPush', async () => {
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const sseSpy = vi.spyOn(sseConnections, 'notifyUserViaSse');
        vi.spyOn(webPush, 'notifyViaWebPush').mockRejectedValueOnce(new Error('mongo blip'));

        await expect(notifyChanges([sampleOp, { ...sampleOp, _id: 'op-2', entityId: 'item-2' }])).resolves.toBeUndefined();

        // SSE fires once with the latest ts (batch contract).
        expect(sseSpy).toHaveBeenCalledTimes(1);
        const tag = errSpy.mock.calls.find((call) => typeof call[0] === 'string' && (call[0] as string).startsWith('[notify-change] notifyViaWebPush failed'));
        expect(tag).toBeDefined();
    });
});

describe('notifyChange — fan-out of ops the GCal push recorded server-side (the link stamp)', () => {
    const linkStampOp: OperationInterface = {
        ...sampleOp,
        _id: 'op-link-stamp',
        deviceId: 'server',
        opType: 'update',
        snapshot: { ...(sampleOp.snapshot as Record<string, unknown>), status: 'calendar', calendarEventId: 'gtd-evt-1' } as OperationInterface['snapshot'],
    };

    it('notifies EVERY device of the link-stamp op — the originating device included — and pushes nothing back to Google for it', async () => {
        const pushSpy = vi.spyOn(calendarPushback, 'maybePushToGCal').mockResolvedValue([linkStampOp]);
        const sseSpy = vi.spyOn(sseConnections, 'notifyUserViaSse');
        const webPushSpy = vi.spyOn(webPush, 'notifyViaWebPush').mockResolvedValue(undefined);

        await notifyChange(sampleOp, { excludeDeviceId: 'device-origin' });

        // The GCal leg is fire-and-forget; its follow-up fan-out lands a few microtasks later.
        await vi.waitFor(() => expect(sseSpy).toHaveBeenCalledTimes(2));
        // 1st SSE: the client's own op, echo-suppressed for its device. 2nd: the server's link stamp, for everyone.
        expect(sseSpy.mock.calls[0]?.[1]).toMatchObject({ sourceDeviceId: 'device-origin' });
        expect(sseSpy.mock.calls[1]?.[1]).toMatchObject({ sourceDeviceId: undefined, ts: linkStampOp.ts });
        await vi.waitFor(() => expect(webPushSpy).toHaveBeenCalledTimes(2));
        expect(webPushSpy.mock.calls[1]?.[1]).toBeNull();
        expect(webPushSpy.mock.calls[1]?.[2]).toEqual([linkStampOp]);
        // No recursion: the link stamp's own notify suppresses the GCal leg.
        expect(pushSpy).toHaveBeenCalledTimes(1);
    });

    it('batch variant fans out recorded ops the same way', async () => {
        vi.spyOn(calendarPushback, 'maybePushToGCal').mockResolvedValue([linkStampOp]);
        const sseSpy = vi.spyOn(sseConnections, 'notifyUserViaSse');
        vi.spyOn(webPush, 'notifyViaWebPush').mockResolvedValue(undefined);

        await notifyChanges([sampleOp], { excludeDeviceId: 'device-origin' });

        await vi.waitFor(() => expect(sseSpy).toHaveBeenCalledTimes(2));
        expect(sseSpy.mock.calls[1]?.[1]).toMatchObject({ sourceDeviceId: undefined });
    });

    it('a push that recorded nothing adds no fan-out', async () => {
        const pushSpy = vi.spyOn(calendarPushback, 'maybePushToGCal').mockResolvedValue([]);
        const sseSpy = vi.spyOn(sseConnections, 'notifyUserViaSse');
        vi.spyOn(webPush, 'notifyViaWebPush').mockResolvedValue(undefined);

        await notifyChange(sampleOp);
        // Settle the fire-and-forget chain deterministically: the mocked push's promise, then the
        // `.then` continuation that would fan out — no wall-clock timer.
        await pushSpy.mock.results[0]?.value;
        await Promise.resolve();
        await Promise.resolve();
        expect(sseSpy).toHaveBeenCalledTimes(1);
    });
});
